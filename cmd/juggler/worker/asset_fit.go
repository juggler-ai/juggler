//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"bytes"
	"container/list"
	"encoding/binary"
	"image"
	"image/jpeg"
	"image/png"
	"sync"

	xdraw "golang.org/x/image/draw"

	"juggler/cmd/juggler/providers/provider"
	"juggler/internal/jlog"
)

// ModelImageMaxEdge is the longest edge, in pixels, an image is sent to a
// model at. It is Anthropic's documented size beyond which Claude downscales
// an image itself, and close to where OpenAI's high-detail mode does: a larger
// image costs upload time and request bytes and buys no detail. Every image in
// a conversation is resent with each request, so a batch of phone photos sent
// at full size can make each request tens of megabytes — past what a provider
// or a proxy accepts, and slow enough to trip the stream-stall watchdog.
const ModelImageMaxEdge = 1568

// maxFitPixels bounds the images FitImageForModel will decode. An upload is
// capped in bytes, not pixels, and a compressed image can declare dimensions
// whose decoded form would take gigabytes; past this one goes out unfitted.
const maxFitPixels = 100_000_000

// fitJPEGQuality is the quality fitted photos are encoded at.
const fitJPEGQuality = 85

// fitConcurrency bounds how many images ResolveForModel fits at once, each
// holding a full decoded frame.
const fitConcurrency = 4

// FittedImage is an image as it is sent to a model: its bytes, their mime
// type, and the pixel dimensions of those bytes.
type FittedImage struct {
	Data   []byte
	Mime   string
	Width  int
	Height int
}

// FitImageForModel scales an image so its long edge is ModelImageMaxEdge,
// turned upright by its EXIF orientation, and reports true. An image that
// already fits — or that it cannot or should not re-encode (undecodable,
// animated-capable GIF, past maxFitPixels) — comes back as given, with
// whatever dimensions could be read, and false.
//
// A fitted image keeps transparency as PNG. An opaque one is a JPEG when it
// was one, and otherwise whichever of PNG and JPEG is smaller: a screenshot
// of text compresses better as PNG, a photo as JPEG.
func FitImageForModel(data []byte, mime string) (FittedImage, bool) {
	unchanged := FittedImage{Data: data, Mime: mime}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return unchanged, false
	}
	unchanged.Width, unchanged.Height = cfg.Width, cfg.Height
	if format == "gif" || max(cfg.Width, cfg.Height) <= ModelImageMaxEdge ||
		int64(cfg.Width)*int64(cfg.Height) > maxFitPixels {
		return unchanged, false
	}
	src, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return unchanged, false
	}

	width, height := fitWithin(cfg.Width, cfg.Height, ModelImageMaxEdge)
	scaled := image.NewRGBA(image.Rect(0, 0, width, height))
	xdraw.CatmullRom.Scale(scaled, scaled.Bounds(), src, src.Bounds(), xdraw.Src, nil)
	if format == "jpeg" {
		// Orient after scaling: the long edge is the same either way round,
		// and turning the small image is the cheap half.
		scaled = orient(scaled, jpegOrientation(data))
	}

	out, outMime, err := encodeFitted(scaled, format == "jpeg")
	if err != nil {
		return unchanged, false
	}
	bounds := scaled.Bounds()
	return FittedImage{Data: out, Mime: outMime, Width: bounds.Dx(), Height: bounds.Dy()}, true
}

// fitWithin scales width×height so the long edge is maxEdge, rounding the
// short edge to the nearest pixel and never below one.
func fitWithin(width, height, maxEdge int) (int, int) {
	if width >= height {
		return maxEdge, max(1, (height*maxEdge+width/2)/width)
	}
	return max(1, (width*maxEdge+height/2)/height), maxEdge
}

// encodeFitted encodes a fitted image as described at FitImageForModel.
func encodeFitted(img *image.RGBA, wasJPEG bool) ([]byte, string, error) {
	opaque := img.Opaque()
	var jpg bytes.Buffer
	if opaque {
		if err := jpeg.Encode(&jpg, img, &jpeg.Options{Quality: fitJPEGQuality}); err != nil {
			return nil, "", err
		}
		if wasJPEG {
			return jpg.Bytes(), "image/jpeg", nil
		}
	}
	var pngBuf bytes.Buffer
	if err := png.Encode(&pngBuf, img); err != nil {
		return nil, "", err
	}
	if opaque && jpg.Len() < pngBuf.Len() {
		return jpg.Bytes(), "image/jpeg", nil
	}
	return pngBuf.Bytes(), "image/png", nil
}

// jpegOrientation reads the EXIF orientation (1–8) from a JPEG's APP1
// segment, or 1 — upright — when there is none or it cannot be read.
func jpegOrientation(data []byte) int {
	if len(data) < 4 || data[0] != 0xFF || data[1] != 0xD8 {
		return 1
	}
	for i := 2; i+4 <= len(data); {
		if data[i] != 0xFF {
			return 1
		}
		marker := data[i+1]
		switch {
		case marker == 0xFF: // fill byte before a marker
			i++
			continue
		case marker == 0x01 || (marker >= 0xD0 && marker <= 0xD7): // no length
			i += 2
			continue
		case marker == 0xDA || marker == 0xD9: // image data: no metadata past here
			return 1
		}
		length := int(binary.BigEndian.Uint16(data[i+2:]))
		if length < 2 || i+2+length > len(data) {
			return 1
		}
		segment := data[i+4 : i+2+length]
		if marker == 0xE1 && bytes.HasPrefix(segment, []byte("Exif\x00\x00")) {
			return exifOrientation(segment[6:])
		}
		i += 2 + length
	}
	return 1
}

// exifOrientation reads the orientation tag (0x0112) from IFD0 of a TIFF
// structure, or 1 when it is absent or malformed.
func exifOrientation(tiff []byte) int {
	if len(tiff) < 8 {
		return 1
	}
	var order binary.ByteOrder
	switch string(tiff[:2]) {
	case "II":
		order = binary.LittleEndian
	case "MM":
		order = binary.BigEndian
	default:
		return 1
	}
	ifd := int(order.Uint32(tiff[4:]))
	if ifd < 8 || ifd+2 > len(tiff) {
		return 1
	}
	count := int(order.Uint16(tiff[ifd:]))
	for k := range count {
		entry := ifd + 2 + 12*k
		if entry+12 > len(tiff) {
			return 1
		}
		if order.Uint16(tiff[entry:]) != 0x0112 {
			continue
		}
		if o := int(order.Uint16(tiff[entry+8:])); o >= 1 && o <= 8 {
			return o
		}
		return 1
	}
	return 1
}

// orient returns img turned upright for an EXIF orientation: 2–4 mirror or
// half-turn it, 5–8 transpose it (swapping width and height). 1 and anything
// out of range return img itself.
func orient(img *image.RGBA, orientation int) *image.RGBA {
	if orientation < 2 || orientation > 8 {
		return img
	}
	width, height := img.Rect.Dx(), img.Rect.Dy()
	outWidth, outHeight := width, height
	if orientation >= 5 {
		outWidth, outHeight = height, width
	}
	out := image.NewRGBA(image.Rect(0, 0, outWidth, outHeight))
	for y := range height {
		for x := range width {
			var dx, dy int
			switch orientation {
			case 2: // mirrored
				dx, dy = width-1-x, y
			case 3: // rotated 180°
				dx, dy = width-1-x, height-1-y
			case 4: // mirrored vertically
				dx, dy = x, height-1-y
			case 5: // transposed
				dx, dy = y, x
			case 6: // rotate 90° clockwise
				dx, dy = height-1-y, x
			case 7: // transversed
				dx, dy = height-1-y, width-1-x
			case 8: // rotate 90° counter-clockwise
				dx, dy = y, width-1-x
			}
			from := img.PixOffset(img.Rect.Min.X+x, img.Rect.Min.Y+y)
			to := out.PixOffset(dx, dy)
			copy(out.Pix[to:to+4], img.Pix[from:from+4])
		}
	}
	return out
}

// fitCacheBudget bounds the fitted bytes modelFitCache holds.
const fitCacheBudget = 64 << 20

// fitCache holds fitted images by asset ID, least recently used evicted
// first. An asset ID is the hash of the original bytes, so an entry is valid
// for every conversation that holds the same image, and for as long as the
// process runs.
type fitCache struct {
	// lock is a one-slot semaphore over the fields below: a send takes it, a
	// receive gives it back.
	lock        chan struct{}
	recency     *list.List // of *fitCacheEntry, most recently used at the front
	elementByID map[string]*list.Element
	heldBytes   int
	budget      int
}

type fitCacheEntry struct {
	id    string
	image FittedImage
}

func newFitCache(budget int) *fitCache {
	return &fitCache{lock: make(chan struct{}, 1), recency: list.New(), elementByID: map[string]*list.Element{}, budget: budget}
}

func (c *fitCache) get(id string) (FittedImage, bool) {
	c.lock <- struct{}{}
	defer func() { <-c.lock }()
	element, ok := c.elementByID[id]
	if !ok {
		return FittedImage{}, false
	}
	c.recency.MoveToFront(element)
	entry, _ := element.Value.(*fitCacheEntry)
	return entry.image, true
}

func (c *fitCache) put(id string, fitted FittedImage) {
	size := len(fitted.Data)
	if size > c.budget {
		return
	}
	c.lock <- struct{}{}
	defer func() { <-c.lock }()
	if _, ok := c.elementByID[id]; ok {
		return
	}
	c.elementByID[id] = c.recency.PushFront(&fitCacheEntry{id: id, image: fitted})
	c.heldBytes += size
	for c.heldBytes > c.budget {
		oldest := c.recency.Back()
		entry, _ := oldest.Value.(*fitCacheEntry)
		c.recency.Remove(oldest)
		delete(c.elementByID, entry.id)
		c.heldBytes -= len(entry.image.Data)
	}
}

// modelFitCache is the process-wide cache ResolveForModel fits through. Every
// request resends every image in the conversation, so without it each turn
// would decode and scale them all again.
var modelFitCache = newFitCache(fitCacheBudget)

// ResolveForModel fills every asset-backed part in msgs with what the model is
// sent — a video's bytes as stored, an image's fitted by FitImageForModel — and sets the
// part's mime and dimensions to those of the bytes, so admission prices the
// image the provider receives rather than the one uploaded. Parts that
// already carry bytes are left alone. A missing asset is logged and its part
// left empty, which the provider adapters drop.
func (s *AssetStore) ResolveForModel(convID string, msgs []provider.Message) {
	var wg sync.WaitGroup
	slots := make(chan struct{}, fitConcurrency)
	for _, msg := range msgs {
		for j := range msg.Parts {
			part := &msg.Parts[j]
			if part.AssetID == "" || len(part.Data) > 0 {
				continue
			}
			wg.Go(func() {
				slots <- struct{}{}
				defer func() { <-slots }()
				s.resolvePartForModel(convID, part)
			})
		}
	}
	wg.Wait()
}

func (s *AssetStore) resolvePartForModel(convID string, part *provider.MediaPart) {
	if part.Type == provider.MediaTypeVideo {
		// A video is sent as stored: there is no fitting for it, and its bytes
		// stay out of the fit cache, which is sized for images.
		data, mime, err := s.Get(convID, part.AssetID)
		if err != nil {
			jlog.Error("asset store: could not resolve asset %s for conversation %s: %v", part.AssetID, convID, err)
			return
		}
		part.Data, part.Mime = data, mime
		return
	}
	fitted, cached := modelFitCache.get(part.AssetID)
	if !cached {
		data, mime, err := s.Get(convID, part.AssetID)
		if err != nil {
			jlog.Error("asset store: could not resolve asset %s for conversation %s: %v", part.AssetID, convID, err)
			return
		}
		var changed bool
		fitted, changed = FitImageForModel(data, mime)
		if changed {
			modelFitCache.put(part.AssetID, fitted)
		} else if part.Mime != "" {
			fitted.Mime = part.Mime
		}
	}
	part.Data = fitted.Data
	part.Mime = fitted.Mime
	if fitted.Width > 0 && fitted.Height > 0 {
		part.Width, part.Height = fitted.Width, fitted.Height
	}
}
