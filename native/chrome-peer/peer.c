// A Node-API addon with one function: who is on the other side of a connected Unix socket, and does
// that process meet a code signing requirement (DESIGN §6.1). Node has no getsockopt, so the app asks
// this addon before it reads one byte from a Chrome host:
//
//   check(fd, requirement) -> { pid, uid, valid, identifier, team }
//
// `fd` is the descriptor of an accepted socket. `requirement` is a code signing requirement in text, or
// null to read the identity without a check (`valid` is then null). The audit token comes from the
// kernel (LOCAL_PEERTOKEN), so the pid cannot be swapped between the read and the check. The addon
// parses no data from the socket.
//
// The Node-API declarations below are the stable C ABI of js_native_api.h (version 8), so the addon
// builds without Node or Electron headers and loads in both.

#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <bsm/libbsm.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>

typedef struct napi_env__ *napi_env;
typedef struct napi_value__ *napi_value;
typedef struct napi_callback_info__ *napi_callback_info;
typedef int napi_status;
typedef int napi_valuetype;
typedef napi_value (*napi_callback)(napi_env env, napi_callback_info info);

enum { napi_ok = 0 };
enum { napi_undefined_type = 0, napi_null_type = 1, napi_number_type = 3, napi_string_type = 4 };

extern napi_status napi_get_cb_info(napi_env env, napi_callback_info info, size_t *argc, napi_value *argv,
                                    napi_value *this_arg, void **data);
extern napi_status napi_typeof(napi_env env, napi_value value, napi_valuetype *result);
extern napi_status napi_get_value_int32(napi_env env, napi_value value, int32_t *result);
extern napi_status napi_get_value_string_utf8(napi_env env, napi_value value, char *buf, size_t bufsize,
                                              size_t *result);
extern napi_status napi_create_object(napi_env env, napi_value *result);
extern napi_status napi_create_int32(napi_env env, int32_t value, napi_value *result);
extern napi_status napi_get_boolean(napi_env env, bool value, napi_value *result);
extern napi_status napi_get_null(napi_env env, napi_value *result);
extern napi_status napi_create_string_utf8(napi_env env, const char *str, size_t length, napi_value *result);
extern napi_status napi_set_named_property(napi_env env, napi_value object, const char *name, napi_value value);
extern napi_status napi_create_function(napi_env env, const char *name, size_t length, napi_callback cb,
                                        void *data, napi_value *result);
extern napi_status napi_throw_error(napi_env env, const char *code, const char *msg);

#define MAX_REQUIREMENT 4096

static napi_value fail(napi_env env, const char *message) {
  napi_throw_error(env, "CHROME_PEER", message);
  return NULL;
}

static void set_string(napi_env env, napi_value object, const char *name, CFStringRef value) {
  napi_value out = NULL;
  char buffer[512];
  if (value && CFStringGetCString(value, buffer, sizeof buffer, kCFStringEncodingUTF8))
    napi_create_string_utf8(env, buffer, strlen(buffer), &out);
  else
    napi_get_null(env, &out);
  napi_set_named_property(env, object, name, out);
}

static napi_value check(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2] = {NULL, NULL};
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 2)
    return fail(env, "check(fd, requirement) takes two arguments");
  int32_t fd = -1;
  if (napi_get_value_int32(env, argv[0], &fd) != napi_ok || fd < 0) return fail(env, "fd is not a descriptor");
  napi_valuetype kind = napi_undefined_type;
  napi_typeof(env, argv[1], &kind);
  char requirement_text[MAX_REQUIREMENT + 1];
  bool has_requirement = false;
  if (kind == napi_string_type) {
    size_t length = 0;
    if (napi_get_value_string_utf8(env, argv[1], requirement_text, sizeof requirement_text, &length) != napi_ok ||
        length >= MAX_REQUIREMENT)
      return fail(env, "requirement is too long");
    has_requirement = true;
  } else if (kind != napi_null_type) {
    return fail(env, "requirement is a string or null");
  }

  audit_token_t token;
  socklen_t token_length = sizeof token;
  if (getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &token_length) != 0 || token_length != sizeof token)
    return fail(env, "the socket has no peer token");

  napi_value result = NULL, value = NULL;
  napi_create_object(env, &result);
  napi_create_int32(env, audit_token_to_pid(token), &value);
  napi_set_named_property(env, result, "pid", value);
  napi_create_int32(env, (int32_t)audit_token_to_euid(token), &value);
  napi_set_named_property(env, result, "uid", value);

  CFDataRef token_data = CFDataCreate(NULL, (const UInt8 *)&token, sizeof token);
  const void *keys[] = {kSecGuestAttributeAudit};
  const void *values[] = {token_data};
  CFDictionaryRef attributes = CFDictionaryCreate(NULL, keys, values, 1, &kCFTypeDictionaryKeyCallBacks,
                                                  &kCFTypeDictionaryValueCallBacks);
  SecCodeRef code = NULL;
  OSStatus copied = SecCodeCopyGuestWithAttributes(NULL, attributes, kSecCSDefaultFlags, &code);
  CFRelease(attributes);
  CFRelease(token_data);

  CFStringRef identifier = NULL, team = NULL;
  CFDictionaryRef signing = NULL;
  SecStaticCodeRef static_code = NULL;
  if (copied == errSecSuccess && SecCodeCopyStaticCode(code, kSecCSDefaultFlags, &static_code) == errSecSuccess &&
      SecCodeCopySigningInformation(static_code, kSecCSSigningInformation, &signing) == errSecSuccess) {
    identifier = CFDictionaryGetValue(signing, kSecCodeInfoIdentifier);
    team = CFDictionaryGetValue(signing, kSecCodeInfoTeamIdentifier);
  }
  set_string(env, result, "identifier", identifier);
  set_string(env, result, "team", team);
  if (signing) CFRelease(signing);
  if (static_code) CFRelease(static_code);

  if (!has_requirement) {
    napi_get_null(env, &value);
  } else {
    bool valid = false;
    if (copied == errSecSuccess) {
      CFStringRef text = CFStringCreateWithCString(NULL, requirement_text, kCFStringEncodingUTF8);
      SecRequirementRef requirement = NULL;
      if (text && SecRequirementCreateWithString(text, kSecCSDefaultFlags, &requirement) == errSecSuccess) {
        valid = SecCodeCheckValidity(code, kSecCSDefaultFlags, requirement) == errSecSuccess;
        CFRelease(requirement);
      }
      if (text) CFRelease(text);
    }
    napi_get_boolean(env, valid, &value);
  }
  napi_set_named_property(env, result, "valid", value);
  if (code) CFRelease(code);
  return result;
}

__attribute__((visibility("default"))) int32_t node_api_module_get_api_version_v1(void) { return 8; }

__attribute__((visibility("default"))) napi_value napi_register_module_v1(napi_env env, napi_value exports) {
  napi_value function = NULL;
  if (napi_create_function(env, "check", 5, check, NULL, &function) != napi_ok) return exports;
  napi_set_named_property(env, exports, "check", function);
  return exports;
}
