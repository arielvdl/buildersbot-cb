// A Node-API addon with one function: who is on the other side of a connected Unix socket, and does
// that process meet a code signing requirement (DESIGN §6.1). Node has no getsockopt, so the app asks
// this addon before it reads one byte from a Chrome host:
//
//   check(fd, requirement, parentRequirement?) -> { pid, uid, valid, identifier, team, parent }
//
// `fd` is the descriptor of an accepted socket. `requirement` is a code signing requirement in text, or
// null to read the identity without a check (`valid` is then null). The audit token comes from the
// kernel (LOCAL_PEERTOKEN), so the pid cannot be swapped between the read and the check. The addon
// parses no data from the socket.
//
// `parent` is the process that started the peer: Chrome starts its native host itself, so a host that
// another program started (a copy of the signed host run by hand) has another parent. It is
// { pid, valid, identifier, team }, with `valid` checked against `parentRequirement` the same way, or
// null when the kernel gives no parent.
//
// A pid alone can name another process by the time of the check (a pid used again), and `exec` keeps
// the pid but changes the code. So the check is bound to versions that the kernel never gives twice:
//   - the peer's records are read by pid, and must carry the pid version of its audit token;
//   - the peer records its parent at fork: the parent's 64-bit unique id and its pid version then
//     (`p_orig_ppidversion`). The process at the parent pid must have that unique id and still that
//     pid version: a parent that ran `exec` after it started the peer (a program that starts the host,
//     then becomes Chrome) has a new pid version and fails;
//   - the same records are read again after the code check, so the process that was checked is the
//     one that started the peer.
// This proves that the peer was started by a process that runs Chrome's code. It cannot prove which
// extension asked Chrome to start it: the pairing of the channel (the extension's static key, pinned
// by the person's choice of words) stays the main defense.
//
// The Node-API declarations below are the stable C ABI of js_native_api.h (version 8), so the addon
// builds without Node or Electron headers and loads in both.

#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <bsm/libbsm.h>
#include <libproc.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <sys/proc_info.h>
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

/** A requirement argument: a string, or null (no check). It returns false on a bad argument. */
static bool read_requirement(napi_env env, napi_value value, char *text, bool *has) {
  napi_valuetype kind = napi_undefined_type;
  napi_typeof(env, value, &kind);
  *has = false;
  if (kind == napi_null_type || kind == napi_undefined_type) return true;
  if (kind != napi_string_type) return false;
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, text, MAX_REQUIREMENT + 1, &length) != napi_ok ||
      length >= MAX_REQUIREMENT)
    return false;
  *has = true;
  return true;
}

/**
 * Sets `identifier`, `team` and `valid` of `object` for a process's code. `valid` is null without a
 * requirement, and false when the code could not be read.
 */
static void describe_code(napi_env env, napi_value object, SecCodeRef code, bool has_requirement,
                          const char *requirement_text) {
  CFStringRef identifier = NULL, team = NULL;
  CFDictionaryRef signing = NULL;
  SecStaticCodeRef static_code = NULL;
  if (code && SecCodeCopyStaticCode(code, kSecCSDefaultFlags, &static_code) == errSecSuccess &&
      SecCodeCopySigningInformation(static_code, kSecCSSigningInformation, &signing) == errSecSuccess) {
    identifier = CFDictionaryGetValue(signing, kSecCodeInfoIdentifier);
    team = CFDictionaryGetValue(signing, kSecCodeInfoTeamIdentifier);
  }
  set_string(env, object, "identifier", identifier);
  set_string(env, object, "team", team);
  if (signing) CFRelease(signing);
  if (static_code) CFRelease(static_code);

  napi_value value = NULL;
  if (!has_requirement) {
    napi_get_null(env, &value);
  } else {
    bool valid = false;
    if (code) {
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
  napi_set_named_property(env, object, "valid", value);
}

/** The code of a process, from a guest attribute (its audit token or its pid), or NULL. */
static SecCodeRef code_for(CFStringRef attribute, CFTypeRef value) {
  const void *keys[] = {attribute};
  const void *values[] = {value};
  CFDictionaryRef attributes = CFDictionaryCreate(NULL, keys, values, 1, &kCFTypeDictionaryKeyCallBacks,
                                                  &kCFTypeDictionaryValueCallBacks);
  SecCodeRef code = NULL;
  if (SecCodeCopyGuestWithAttributes(NULL, attributes, kSecCSDefaultFlags, &code) != errSecSuccess) code = NULL;
  CFRelease(attributes);
  return code;
}

/** The parent pid of a process, or -1. */
static pid_t parent_of(pid_t pid) {
  struct proc_bsdinfo info;
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof info) != (int)sizeof info) return -1;
  return (pid_t)info.pbi_ppid;
}

// `proc_pidinfo` flavor 17 (PROC_PIDUNIQIDENTIFIERINFO), as xnu's `proc_info_private.h` declares it.
// The SDK does not export it; a kernel that gives another size fails the check (fail closed).
#define UNIQUE_IDENTIFIERS 17
struct unique_identifiers {
  uint8_t uuid[16];
  uint64_t unique_id;
  uint64_t parent_unique_id;
  int32_t pid_version;
  int32_t parent_pid_version_at_fork;
  uint64_t reserved3;
  uint64_t reserved4;
};

static bool identifiers_of(pid_t pid, struct unique_identifiers *out) {
  return proc_pidinfo(pid, UNIQUE_IDENTIFIERS, 0, out, sizeof *out) == (int)sizeof *out;
}

/**
 * Whether `parent` is, now, the very process that started the peer: the peer is the incarnation of
 * its audit token, and the parent has the unique id and the pid version that the peer recorded at
 * fork (no other process, and no `exec` since).
 */
static bool same_parent(pid_t pid, int32_t peer_version, pid_t parent) {
  struct unique_identifiers peer, father;
  if (!identifiers_of(pid, &peer) || !identifiers_of(parent, &father)) return false;
  return peer.pid_version == peer_version && parent_of(pid) == parent &&
         father.unique_id == peer.parent_unique_id && father.pid_version == peer.parent_pid_version_at_fork;
}

static napi_value check(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3] = {NULL, NULL, NULL};
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 2 || argc > 3)
    return fail(env, "check(fd, requirement, parentRequirement?) takes two or three arguments");
  int32_t fd = -1;
  if (napi_get_value_int32(env, argv[0], &fd) != napi_ok || fd < 0) return fail(env, "fd is not a descriptor");
  char requirement_text[MAX_REQUIREMENT + 1];
  char parent_text[MAX_REQUIREMENT + 1];
  bool has_requirement = false, has_parent_requirement = false;
  if (!read_requirement(env, argv[1], requirement_text, &has_requirement))
    return fail(env, "requirement is a string or null, and shorter than 4096 bytes");
  if (argc == 3 && !read_requirement(env, argv[2], parent_text, &has_parent_requirement))
    return fail(env, "parentRequirement is a string or null, and shorter than 4096 bytes");

  audit_token_t token;
  socklen_t token_length = sizeof token;
  if (getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &token_length) != 0 || token_length != sizeof token)
    return fail(env, "the socket has no peer token");

  napi_value result = NULL, value = NULL;
  napi_create_object(env, &result);
  pid_t pid = audit_token_to_pid(token);
  napi_create_int32(env, pid, &value);
  napi_set_named_property(env, result, "pid", value);
  napi_create_int32(env, (int32_t)audit_token_to_euid(token), &value);
  napi_set_named_property(env, result, "uid", value);

  CFDataRef token_data = CFDataCreate(NULL, (const UInt8 *)&token, sizeof token);
  SecCodeRef code = code_for(kSecGuestAttributeAudit, token_data);
  CFRelease(token_data);
  describe_code(env, result, code, has_requirement, requirement_text);
  if (code) CFRelease(code);

  int32_t peer_version = (int32_t)audit_token_to_pidversion(token);
  pid_t parent = parent_of(pid);
  // Read before the code check, then again after it: the same process from start to end.
  bool parent_before = parent > 0 && same_parent(pid, peer_version, parent);
  if (parent <= 0) {
    napi_get_null(env, &value);
  } else {
    napi_create_object(env, &value);
    napi_value parent_pid = NULL;
    napi_create_int32(env, parent, &parent_pid);
    napi_set_named_property(env, value, "pid", parent_pid);
    int32_t number = parent;
    CFNumberRef parent_number = CFNumberCreate(NULL, kCFNumberSInt32Type, &number);
    SecCodeRef parent_code = code_for(kSecGuestAttributePid, parent_number);
    CFRelease(parent_number);
    describe_code(env, value, parent_code, has_parent_requirement, parent_text);
    if (parent_code) CFRelease(parent_code);
    // The parent is known by its pid: one that is not the process that started the peer, before and
    // after the code check, fails.
    if (has_parent_requirement && !(parent_before && same_parent(pid, peer_version, parent))) {
      napi_value invalid = NULL;
      napi_get_boolean(env, false, &invalid);
      napi_set_named_property(env, value, "valid", invalid);
    }
  }
  napi_set_named_property(env, result, "parent", value);
  return result;
}

__attribute__((visibility("default"))) int32_t node_api_module_get_api_version_v1(void) { return 8; }

__attribute__((visibility("default"))) napi_value napi_register_module_v1(napi_env env, napi_value exports) {
  napi_value function = NULL;
  if (napi_create_function(env, "check", 5, check, NULL, &function) != napi_ok) return exports;
  napi_set_named_property(env, exports, "check", function);
  return exports;
}
