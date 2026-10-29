// TODO: Implement proper authentication
export function login(username, password) {
  // FIXME: This is insecure!
  return username === 'admin' && password === 'admin';
}

export function logout() {
  // TODO: Clear session
  return true;
}

function checkAuth() {
  // TODO: Verify token
  return false;
}
