// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
#include <napi.h>

#if defined(__linux__)
#include <sys/socket.h>
#include <unistd.h>
#endif

namespace {

struct PeerCredResult {
  int uid = -1;
  int gid = -1;
  int pid = -1;
  bool ok = false;
};

PeerCredResult getPeerCredFromFd(int fd) {
  PeerCredResult result;
#if defined(__linux__) && defined(SO_PEERCRED)
  struct ucred cred {};
  socklen_t len = sizeof(cred);
  if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &cred, &len) == 0) {
    result.uid = static_cast<int>(cred.uid);
    result.gid = static_cast<int>(cred.gid);
    result.pid = static_cast<int>(cred.pid);
    result.ok = true;
  }
#endif
  return result;
}

Napi::Value GetPeerCred(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "fd (number) required").ThrowAsJavaScriptException();
    return env.Null();
  }

  const int fd = info[0].As<Napi::Number>().Int32Value();
  const PeerCredResult cred = getPeerCredFromFd(fd);
  Napi::Object obj = Napi::Object::New(env);
  obj.Set("ok", Napi::Boolean::New(env, cred.ok));
  if (cred.ok) {
    obj.Set("uid", Napi::Number::New(env, cred.uid));
    obj.Set("gid", Napi::Number::New(env, cred.gid));
    obj.Set("pid", Napi::Number::New(env, cred.pid));
  }
  return obj;
}

}  // namespace

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("getPeerCred", Napi::Function::New(env, GetPeerCred));
  return exports;
}

NODE_API_MODULE(peer_cred, Init)
