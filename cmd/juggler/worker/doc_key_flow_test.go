//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"go/ast"
	"go/token"
	"go/types"
	"slices"
	"sort"
)

// docFlow finds every key position in the worker source: each place a string
// names a key of the doc, whether a Y.Map's or a Go map's that is a copy of
// doc state or will be written into it. TestWireParityDocKeysAreConstants holds
// every one of them to the key constants.
//
// A Go map is doc state when it shares a value with the doc: read out of it
// (a Y.Map Get, GetMap or ToJson, then whatever fromYcrdt makes of that) or
// written into it (a Y.Map Set, Insert or Push, or any call into ycrdt). Which
// maps those are is computed, not listed: the source is type-checked, and
// values are followed through assignment, parameters, results, callbacks, type
// switches, ranges and key-by-key copies, unification style — every variable,
// parameter, result and map literal a doc value can reach joins one class, and
// a class's element (what indexing, ranging or a literal's values yield) is
// itself a class. A class holding doc state taints its elements too, so a map
// nested inside doc state is doc state, at any depth.
//
// A key position is then: an index into, delete from, or literal key of doc
// state; the key argument of a Y.Map Get/Set/Delete/Has or a yMap* reader; and,
// computed by fixpoint, the argument a caller passes to any string parameter
// that itself reaches a key position (a forwarder). A key position that is a
// local variable is followed to what it was assigned: a string literal, or the
// elements of a literal it ranges over.
type docFlow struct {
	src  workerSource
	info *types.Info

	vars    map[types.Object]*flowNode
	slots   map[slotKey]*flowNode // a func-typed variable's parameters
	results map[slotKey]*flowNode // a function's results
	lits    map[*ast.CompositeLit]*flowNode
	// docRead is the class of every value read out of the doc.
	docRead *flowNode

	decls map[*types.Func]*ast.FuncDecl
	// rangeKeyOf is the map a range statement's key variable walks.
	rangeKeyOf map[types.Object]ast.Expr
	// keyLits are the literals a local string variable is given: assigned
	// directly, or ranged over as a literal's elements.
	keyLits map[types.Object][]ast.Expr
	// keyParams are the string parameters that reach a key position.
	keyParams map[types.Object]bool
	// funcLitOwner is the func-typed parameter a function literal is passed
	// for: its returns are that parameter's results.
	funcLitOwner map[*ast.FuncLit]types.Object
}

type slotKey struct {
	obj types.Object
	i   int
}

type flowNode struct {
	parent  *flowNode
	elem    *flowNode
	tainted bool
}

func (n *flowNode) find() *flowNode {
	for n.parent != nil {
		if n.parent.parent != nil {
			n.parent = n.parent.parent
		}
		n = n.parent
	}
	return n
}

// union joins two classes and, recursively, their elements; it reports whether
// anything changed.
func union(a, b *flowNode) bool {
	if a == nil || b == nil {
		return false
	}
	a, b = a.find(), b.find()
	if a == b {
		return false
	}
	b.parent = a
	a.tainted = a.tainted || b.tainted
	switch {
	case a.elem == nil:
		a.elem = b.elem
	case b.elem != nil:
		union(a.elem, b.elem)
	}
	return true
}

func elemOf(n *flowNode) *flowNode {
	if n == nil {
		return nil
	}
	n = n.find()
	if n.elem == nil {
		n.elem = &flowNode{}
	}
	return n.elem
}

func taint(n *flowNode) bool {
	if n == nil {
		return false
	}
	n = n.find()
	if n.tainted {
		return false
	}
	n.tainted = true
	return true
}

// isTainted reports whether n's class holds doc state. Tainting a class taints
// its elements, at read time: the element pointer can be replaced by a union
// after the container was tainted.
func isTainted(n *flowNode) bool {
	return n != nil && n.find().tainted
}

func newDocFlow(src workerSource) *docFlow {
	files := make([]*ast.File, 0, len(src.files))
	names := make([]string, 0, len(src.files))
	for name := range src.files {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		files = append(files, src.files[name])
	}
	info := &types.Info{
		Types:     map[ast.Expr]types.TypeAndValue{},
		Defs:      map[*ast.Ident]types.Object{},
		Uses:      map[*ast.Ident]types.Object{},
		Implicits: map[ast.Node]types.Object{},
	}
	conf := types.Config{Importer: shallowImporter{}, Error: func(error) {}}
	_, _ = conf.Check("worker", src.fset, files, info)

	f := &docFlow{
		src: src, info: info,
		vars: map[types.Object]*flowNode{}, slots: map[slotKey]*flowNode{},
		results: map[slotKey]*flowNode{}, lits: map[*ast.CompositeLit]*flowNode{},
		docRead: &flowNode{tainted: true},
		decls:   map[*types.Func]*ast.FuncDecl{}, rangeKeyOf: map[types.Object]ast.Expr{},
		keyLits: map[types.Object][]ast.Expr{}, keyParams: map[types.Object]bool{}, funcLitOwner: map[*ast.FuncLit]types.Object{},
	}
	for _, file := range files {
		for _, d := range file.Decls {
			if fd, ok := d.(*ast.FuncDecl); ok {
				if fn, ok := info.Defs[fd.Name].(*types.Func); ok {
					f.decls[fn] = fd
				}
			}
		}
	}
	// Unification only joins classes and only sets taint, so repeating the
	// walk until nothing changes reaches the fixpoint.
	for f.walk() {
	}
	return f
}

// carriesKeys reports whether a value of type t can be, or hold, a map keyed
// by string: only those carry doc keys, so only those are followed. A type
// the shallow type-check could not resolve (a ycrdt one) is followed too.
func carriesKeys(t types.Type) bool {
	if t == nil {
		return true
	}
	switch u := t.Underlying().(type) {
	case *types.Map:
		k, ok := u.Key().Underlying().(*types.Basic)
		return ok && k.Info()&types.IsString != 0
	case *types.Interface:
		return true
	case *types.Slice:
		return carriesKeys(u.Elem())
	case *types.Array:
		return carriesKeys(u.Elem())
	case *types.Pointer:
		return carriesKeys(u.Elem())
	case *types.Basic:
		return u.Kind() == types.Invalid
	}
	return false
}

func (f *docFlow) varNode(obj types.Object) *flowNode {
	if _, ok := obj.(*types.Var); !ok || !carriesKeys(obj.Type()) {
		return nil
	}
	n := f.vars[obj]
	if n == nil {
		n = &flowNode{}
		f.vars[obj] = n
	}
	return n
}

func (f *docFlow) slot(m map[slotKey]*flowNode, obj types.Object, i int) *flowNode {
	k := slotKey{obj, i}
	n := m[k]
	if n == nil {
		n = &flowNode{}
		m[k] = n
	}
	return n
}

// obj is the variable or function an identifier names.
func (f *docFlow) obj(id *ast.Ident) types.Object {
	if o := f.info.Uses[id]; o != nil {
		return o
	}
	return f.info.Defs[id]
}

// callee is the package function or method a call resolves to, with its
// declaration, or nil for anything else (a builtin, a conversion, a call into
// another package or through a func value).
func (f *docFlow) callee(call *ast.CallExpr) (*types.Func, *ast.FuncDecl) {
	var id *ast.Ident
	switch fn := ast.Unparen(call.Fun).(type) {
	case *ast.Ident:
		id = fn
	case *ast.SelectorExpr:
		id = fn.Sel
	case *ast.IndexExpr: // a generic instantiation
		if x, ok := fn.X.(*ast.Ident); ok {
			id = x
		}
	}
	if id == nil {
		return nil, nil
	}
	fn, ok := f.info.Uses[id].(*types.Func)
	if !ok {
		return nil, nil
	}
	return fn, f.decls[fn]
}

// external reports whether a call leaves this package unresolved: a method of
// a value whose type the shallow importer cannot see (a Y.Map, a Y.Array), or
// a function of another package. ycrdt is the only package the worker hands
// doc values to by method, so an unresolved method named for a Y.Map/Y.Array
// read or write is one.
func (f *docFlow) external(call *ast.CallExpr) (pkg string, method string, ok bool) {
	sel, isSel := ast.Unparen(call.Fun).(*ast.SelectorExpr)
	if !isSel {
		return "", "", false
	}
	if id, isID := sel.X.(*ast.Ident); isID {
		if pn, isPkg := f.info.Uses[id].(*types.PkgName); isPkg {
			return pn.Imported().Path(), sel.Sel.Name, true
		}
	}
	if f.info.Uses[sel.Sel] != nil {
		return "", "", false
	}
	return "", sel.Sel.Name, true
}

const ycrdtPath = "github.com/skyterra/y-crdt"

// node is the class of the value an expression denotes, or nil when it is not
// a value the flow follows.
func (f *docFlow) node(e ast.Expr) *flowNode {
	if tv, ok := f.info.Types[e]; ok {
		t := tv.Type
		if tuple, ok := t.(*types.Tuple); ok && tuple.Len() > 0 { // v, ok := …
			t = tuple.At(0).Type()
		}
		if !carriesKeys(t) {
			return nil
		}
	}
	switch e := ast.Unparen(e).(type) {
	case *ast.Ident:
		if o := f.obj(e); o != nil {
			return f.varNode(o)
		}
	case *ast.TypeAssertExpr:
		return f.node(e.X)
	case *ast.UnaryExpr:
		if e.Op == token.AND {
			return f.node(e.X)
		}
	case *ast.StarExpr:
		return f.node(e.X)
	case *ast.SliceExpr:
		return f.node(e.X)
	case *ast.IndexExpr:
		return elemOf(f.node(e.X))
	case *ast.SelectorExpr:
		if sel, ok := f.info.Uses[e.Sel].(*types.Var); ok && sel.IsField() {
			return f.varNode(sel)
		}
	case *ast.CompositeLit:
		n := f.lits[e]
		if n == nil {
			n = &flowNode{}
			f.lits[e] = n
		}
		return n
	case *ast.CallExpr:
		if tv, ok := f.info.Types[e.Fun]; ok && tv.IsType() && len(e.Args) == 1 {
			return f.node(e.Args[0])
		}
		if fn, _ := f.callee(e); fn != nil {
			return f.slot(f.results, fn, 0)
		}
		if id, ok := ast.Unparen(e.Fun).(*ast.Ident); ok {
			if v, ok := f.obj(id).(*types.Var); ok {
				return f.slot(f.results, v, 0)
			}
			if b, ok := f.info.Uses[id].(*types.Builtin); ok && b.Name() == "append" && len(e.Args) > 0 {
				return f.node(e.Args[0])
			}
		}
		if pkg, name, ok := f.external(e); ok && (pkg == ycrdtPath || (pkg == "" && (name == "Get" || name == "GetMap" || name == "ToJson"))) {
			return f.docRead
		}
	}
	return nil
}

// walk applies every flow rule once, reporting whether anything changed.
func (f *docFlow) walk() bool {
	changed := false
	join := func(a, b *flowNode) {
		if union(a, b) {
			changed = true
		}
	}
	mark := func(n *flowNode) {
		if taint(n) {
			changed = true
		}
	}
	keyPos := func(e ast.Expr) {
		if f.keyPosition(e) {
			changed = true
		}
		// A key that is a range key hands on the keys of the map it walks.
		if id, ok := ast.Unparen(e).(*ast.Ident); ok {
			if src, ok := f.rangeKeyOf[f.obj(id)]; ok {
				mark(f.node(src))
			}
		}
	}
	// funcArg joins a function value passed where a func-typed parameter is
	// expected: the parameter's parameters and results are the value's.
	funcArg := func(param types.Object, arg ast.Expr) {
		sig, ok := param.Type().Underlying().(*types.Signature)
		if !ok {
			return
		}
		var params []types.Object
		switch a := ast.Unparen(arg).(type) {
		case *ast.FuncLit:
			for _, field := range a.Type.Params.List {
				for _, name := range field.Names {
					params = append(params, f.info.Defs[name])
				}
			}
			f.funcLitOwner[a] = param
		case *ast.Ident, *ast.SelectorExpr:
			var id *ast.Ident
			if s, ok := a.(*ast.SelectorExpr); ok {
				id = s.Sel
			} else {
				id = a.(*ast.Ident)
			}
			switch o := f.obj(id).(type) {
			case *types.Var:
				for i := 0; i < sig.Params().Len(); i++ {
					join(f.slot(f.slots, param, i), f.slot(f.slots, o, i))
				}
				for i := 0; i < sig.Results().Len(); i++ {
					join(f.slot(f.results, param, i), f.slot(f.results, o, i))
				}
				return
			case *types.Func:
				s := o.Type().(*types.Signature)
				for i := 0; i < s.Params().Len(); i++ {
					params = append(params, s.Params().At(i))
				}
				for i := 0; i < s.Results().Len(); i++ {
					join(f.slot(f.results, param, i), f.slot(f.results, o, i))
				}
			}
		}
		for i, p := range params {
			if p != nil {
				join(f.slot(f.slots, param, i), f.varNode(p))
			}
		}
	}

	for _, name := range sortedFiles(f.src) {
		file := f.src.files[name]
		var fnStack []types.Object // the function each return belongs to
		var visit func(n ast.Node) bool
		visit = func(n ast.Node) bool {
			switch n := n.(type) {
			case *ast.FuncDecl:
				fnStack = append(fnStack, f.info.Defs[n.Name])
				if n.Body != nil {
					ast.Inspect(n.Body, visit)
				}
				fnStack = fnStack[:len(fnStack)-1]
				return false
			case *ast.FuncLit:
				fnStack = append(fnStack, f.funcLitOwner[n])
				ast.Inspect(n.Body, visit)
				fnStack = fnStack[:len(fnStack)-1]
				return false
			case *ast.ReturnStmt:
				if len(fnStack) > 0 && fnStack[len(fnStack)-1] != nil {
					fn := fnStack[len(fnStack)-1]
					for k, r := range n.Results {
						join(f.slot(f.results, fn, k), f.node(r))
					}
				}
			case *ast.AssignStmt:
				f.assign(n.Lhs, n.Rhs, join)
			case *ast.ValueSpec:
				lhs := make([]ast.Expr, len(n.Names))
				for i, id := range n.Names {
					lhs[i] = id
				}
				f.assign(lhs, n.Values, join)
			case *ast.RangeStmt:
				x := f.node(n.X)
				if id, ok := n.Value.(*ast.Ident); ok {
					join(f.node(id), elemOf(x))
					if lit, ok := ast.Unparen(n.X).(*ast.CompositeLit); ok {
						if o := f.obj(id); o != nil && len(f.keyLits[o]) == 0 {
							for _, elt := range lit.Elts {
								if strLit(elt) != "" {
									f.keyLits[o] = append(f.keyLits[o], elt)
								}
							}
						}
					}
				}
				if id, ok := n.Key.(*ast.Ident); ok {
					if o := f.obj(id); o != nil {
						f.rangeKeyOf[o] = n.X
					}
				}
			case *ast.TypeSwitchStmt:
				var x ast.Expr
				switch a := n.Assign.(type) {
				case *ast.AssignStmt:
					x = a.Rhs[0].(*ast.TypeAssertExpr).X
				case *ast.ExprStmt:
					x = a.X.(*ast.TypeAssertExpr).X
				}
				for _, c := range n.Body.List {
					if o := f.info.Implicits[c]; o != nil {
						join(f.varNode(o), f.node(x))
					}
				}
			case *ast.CompositeLit:
				lit := f.node(n)
				for _, elt := range n.Elts {
					if kv, ok := elt.(*ast.KeyValueExpr); ok {
						if f.isMapLit(n) {
							join(elemOf(lit), f.node(kv.Value))
							if isTainted(lit) {
								keyPos(kv.Key)
							}
						}
						continue
					}
					join(elemOf(lit), f.node(elt))
				}
			case *ast.IndexExpr:
				if isTainted(f.node(n.X)) && f.isMapOrAny(n.X) {
					keyPos(n.Index)
				}
			case *ast.CallExpr:
				f.call(n, join, mark, keyPos, funcArg)
			}
			return true
		}
		ast.Inspect(file, visit)
	}
	return changed
}

func (f *docFlow) isMapLit(lit *ast.CompositeLit) bool {
	tv, ok := f.info.Types[lit]
	if !ok {
		return false
	}
	_, isMap := tv.Type.Underlying().(*types.Map)
	return isMap
}

// isMapOrAny reports whether indexing e names a key: e is a map, or a value the
// checker could not type (one built from an unresolved import).
func (f *docFlow) isMapOrAny(e ast.Expr) bool {
	tv, ok := f.info.Types[e]
	if !ok || tv.Type == nil {
		return true
	}
	switch tv.Type.Underlying().(type) {
	case *types.Map, *types.Interface:
		return true
	case *types.Basic:
		return tv.Type.Underlying().(*types.Basic).Kind() == types.Invalid
	}
	return false
}

func (f *docFlow) assign(lhs, rhs []ast.Expr, join func(a, b *flowNode)) {
	if len(lhs) == len(rhs) {
		for i := range lhs {
			join(f.node(lhs[i]), f.node(rhs[i]))
			f.copiesKeys(lhs[i], join)
			if id, ok := lhs[i].(*ast.Ident); ok && strLit(rhs[i]) != "" {
				if o, ok := f.obj(id).(*types.Var); ok && !slices.Contains(f.keyLits[o], rhs[i]) {
					f.keyLits[o] = append(f.keyLits[o], rhs[i])
				}
			}
		}
		return
	}
	if len(rhs) != 1 {
		return
	}
	if call, ok := ast.Unparen(rhs[0]).(*ast.CallExpr); ok {
		if fn, _ := f.callee(call); fn != nil {
			for k := range lhs {
				join(f.node(lhs[k]), f.slot(f.results, fn, k))
			}
			return
		}
	}
	join(f.node(lhs[0]), f.node(rhs[0]))
}

// copiesKeys joins dst and src for `dst[k] = …` where k is the key variable
// of a range over src: dst receives src's keys.
func (f *docFlow) copiesKeys(lhs ast.Expr, join func(a, b *flowNode)) {
	ix, ok := lhs.(*ast.IndexExpr)
	if !ok {
		return
	}
	id, ok := ix.Index.(*ast.Ident)
	if !ok {
		return
	}
	if src, ok := f.rangeKeyOf[f.obj(id)]; ok {
		join(f.node(ix.X), f.node(src))
	}
}

func (f *docFlow) call(n *ast.CallExpr, join func(a, b *flowNode), mark func(*flowNode), keyPos func(ast.Expr), funcArg func(types.Object, ast.Expr)) {
	if id, ok := ast.Unparen(n.Fun).(*ast.Ident); ok {
		if b, ok := f.info.Uses[id].(*types.Builtin); ok {
			switch b.Name() {
			case "delete":
				if len(n.Args) == 2 && isTainted(f.node(n.Args[0])) {
					keyPos(n.Args[1])
				}
			case "append":
				if len(n.Args) > 1 {
					for _, a := range n.Args[1:] {
						join(elemOf(f.node(n.Args[0])), f.node(a))
					}
				}
			}
			return
		}
		if v, ok := f.obj(id).(*types.Var); ok {
			for i, a := range n.Args {
				join(f.slot(f.slots, v, i), f.node(a))
			}
			return
		}
	}

	if fn, decl := f.callee(n); fn != nil {
		sig := fn.Type().(*types.Signature)
		// A method's receiver is the value it is called on.
		if sel, ok := ast.Unparen(n.Fun).(*ast.SelectorExpr); ok && sig.Recv() != nil {
			join(f.varNode(sig.Recv()), f.node(sel.X))
		}
		for i, a := range n.Args {
			if i >= sig.Params().Len() || (sig.Variadic() && i >= sig.Params().Len()-1) {
				break
			}
			p := sig.Params().At(i)
			join(f.varNode(p), f.node(a))
			funcArg(p, a)
			if decl != nil && f.keyParams[p] {
				keyPos(a)
			}
		}
		return
	}

	pkg, name, ok := f.external(n)
	if !ok {
		return
	}
	if pkg == ycrdtPath {
		for _, a := range n.Args {
			mark(f.node(a))
		}
		return
	}
	if pkg != "" {
		return
	}
	switch {
	case yMapMethods[name]:
		keyPos(n.Args[0])
		if name == "Set" && len(n.Args) == 2 {
			mark(f.node(n.Args[1]))
		}
	case name == "Insert" || name == "Push":
		for _, a := range n.Args {
			mark(f.node(a))
		}
	}
}

// keyPosition records that e names a doc key. A string parameter becomes a
// key parameter, so its callers' arguments are key positions in turn.
func (f *docFlow) keyPosition(e ast.Expr) bool {
	id, ok := ast.Unparen(e).(*ast.Ident)
	if !ok {
		return false
	}
	v, ok := f.obj(id).(*types.Var)
	if !ok || f.keyParams[v] || !f.isParam(v) {
		return false
	}
	f.keyParams[v] = true
	return true
}

func (f *docFlow) isParam(v *types.Var) bool {
	for _, d := range f.decls {
		if d.Type.Params == nil {
			continue
		}
		for _, field := range d.Type.Params.List {
			for _, name := range field.Names {
				if f.info.Defs[name] == v {
					return true
				}
			}
		}
	}
	return false
}

// keyPositions calls fn for every key position in the source, with the file
// it is in and, for a call argument, the name of the function called. A local
// string variable at a key position is replaced by the literals it was given.
func (f *docFlow) keyPositions(fn func(file string, e ast.Expr, via string)) {
	emit := func(file string, e ast.Expr, via string) {
		if id, ok := ast.Unparen(e).(*ast.Ident); ok {
			if lits := f.keyLits[f.obj(id)]; len(lits) > 0 {
				for _, l := range lits {
					fn(file, l, via)
				}
				return
			}
		}
		fn(file, e, via)
	}
	for _, name := range sortedFiles(f.src) {
		ast.Inspect(f.src.files[name], func(n ast.Node) bool {
			switch n := n.(type) {
			case *ast.CompositeLit:
				if f.isMapLit(n) && isTainted(f.node(n)) {
					for _, elt := range n.Elts {
						if kv, ok := elt.(*ast.KeyValueExpr); ok {
							emit(name, kv.Key, "")
						}
					}
				}
			case *ast.IndexExpr:
				if isTainted(f.node(n.X)) && f.isMapOrAny(n.X) {
					emit(name, n.Index, "")
				}
			case *ast.CallExpr:
				if id, ok := ast.Unparen(n.Fun).(*ast.Ident); ok {
					if b, ok := f.info.Uses[id].(*types.Builtin); ok {
						if b.Name() == "delete" && len(n.Args) == 2 && isTainted(f.node(n.Args[0])) {
							emit(name, n.Args[1], "")
						}
						return true
					}
				}
				if fn, decl := f.callee(n); fn != nil && decl != nil {
					sig := fn.Type().(*types.Signature)
					for i, a := range n.Args {
						if i < sig.Params().Len() && f.keyParams[sig.Params().At(i)] {
							emit(name, a, fn.Name())
						}
					}
					return true
				}
				if pkg, method, ok := f.external(n); ok && pkg == "" && yMapMethods[method] && len(n.Args) > 0 {
					emit(name, n.Args[0], method)
				}
			}
			return true
		})
	}
}

func sortedFiles(src workerSource) []string {
	names := make([]string, 0, len(src.files))
	for name := range src.files {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}
