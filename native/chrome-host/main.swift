// The Native Messaging host of the Builders Bot Chrome extension (DESIGN §6.1).
//
// Chrome starts this program for the extension and talks to it on stdin and stdout: each frame is a
// uint32 length in native byte order, then that many bytes of UTF-8 JSON. The host copies whole frames
// between Chrome and a private Unix socket of the Builders Bot app, with the same framing. It reads no
// message: after a handshake in clear, every message is AES-256-GCM between the extension and the app,
// with keys that the two sides pinned when the person paired them. The host is a barrier, not a party:
//
// - it runs only for the extension origin compiled into it (`argv[1]`), else it exits with code 2;
// - it connects only to a socket in a private folder of this user (owner only, mode 0700), never /tmp;
// - a store build checks the code signature of the process on the other side of the socket
//   (LOCAL_PEERTOKEN, then the Builders Bot requirement) before it passes one byte;
// - it reads a frame length before it allocates, and refuses a frame above the cap of its direction;
// - it holds at most one frame for each direction, and reads a side only when the other side took the
//   last frame, so a slow side slows the other one down (backpressure) and memory stays bounded;
// - its own frames are a closed list, outside the cipher: `hello` once, first, and `status` when the app
//   connection opens or closes. A frame from the app must start as a handshake message (`{"k":"`) or a
//   sealed frame (`{"v":1,`), so the app side of the socket cannot write a frame that looks like the host's.
//
// It also reports, as a hint and not as proof, whether its parent process is Google Chrome.
//
// Exit codes: 0 Chrome closed the port; 2 wrong origin; 3 the app was away for 24 hours; 4 Chrome sent
// a frame the host refuses; 5 an I/O error with Chrome; 6 no usable socket folder.

import CoreFoundation
import Darwin
import Security

// MARK: - Limits

/// Chrome refuses a message above 1 MiB from a host; the app keeps each frame below this.
let maxFrameToChrome = 1_000_000
/// The largest frame the host passes to the app.
let maxFrameToApp = 16 * 1024 * 1024
/// The app has been away this long: the host exits, and the extension waits for an alarm.
let offlineExitSeconds: Double = 24 * 60 * 60
/// A safety retry while the app is away, besides the folder watch.
let offlineRetrySeconds: Double = 10
/// After a change in the socket folder, quick retries while the app starts to listen.
let quickRetryDelays: [Double] = [0, 0.05, 0.1, 0.2, 0.4, 0.8]

let googleChromeRequirement =
  "anchor apple generic and certificate leaf[subject.OU] = \"EQHXZ8M8AV\" and identifier \"com.google.Chrome\""

// MARK: - Diagnostics

/// Development and E2E builds write a few lines about their state, never a frame or its length, to a
/// file in the private socket folder. A store build writes nothing.
var diagnosticsFd: Int32 = -1

func note(_ text: String) {
  guard diagnosticsFd >= 0 else { return }
  let line = "\(Int(time(nil))) pid=\(getpid()) \(text)\n"
  _ = line.withCString { write(diagnosticsFd, $0, strlen($0)) }
}

// MARK: - Clock

func now() -> Double {
  var spec = timespec()
  clock_gettime(CLOCK_MONOTONIC, &spec)
  return Double(spec.tv_sec) + Double(spec.tv_nsec) / 1_000_000_000
}

// MARK: - Socket folder

func darwinUserTempDir() -> String? {
  var buffer = [CChar](repeating: 0, count: Int(PATH_MAX))
  guard confstr(_CS_DARWIN_USER_TEMP_DIR, &buffer, buffer.count) > 0 else { return nil }
  let path = String(cString: buffer)
  return path.hasSuffix("/") ? String(path.dropLast()) : path
}

func homeDirectory() -> String? {
  guard let entry = getpwuid(getuid()), let directory = entry.pointee.pw_dir else { return nil }
  return String(cString: directory)
}

/// The socket path, as the app computes it: never from the environment, so a parent cannot move it.
func socketPath() -> String? {
  let name = HostConfig.socketName
  var folder: String
  if HostConfig.socketInTempDir {
    guard let temp = darwinUserTempDir() else { return nil }
    folder = temp + "/" + HostConfig.tempFolderName
  } else {
    guard let home = homeDirectory() else { return nil }
    folder = home + "/Library/Application Support/Builders Bot/cb"
  }
  // `sun_path` holds 104 bytes with its terminator on macOS.
  if (folder + "/" + name).utf8.count > 103 {
    guard let temp = darwinUserTempDir() else { return nil }
    folder = temp + "/bb"
  }
  return folder + "/" + name
}

func folderOf(_ path: String) -> String {
  guard let slash = path.lastIndex(of: "/") else { return "." }
  return String(path[..<slash])
}

/// The folder exists, is a folder (not a link), belongs to this user, and no one else can enter it.
func isPrivateFolder(_ folder: String) -> Bool {
  var info = stat()
  guard lstat(folder, &info) == 0 else { return false }
  return (info.st_mode & S_IFMT) == S_IFDIR && info.st_uid == getuid() && (info.st_mode & 0o077) == 0
}

// MARK: - Code signatures (CoreFoundation only: no Foundation in this process)

let utf8Encoding = CFStringBuiltInEncodings.UTF8.rawValue

func cfString(_ text: String) -> CFString {
  CFStringCreateWithCString(nil, text, utf8Encoding)
}

func cfDictionary(_ key: CFString, _ value: CFTypeRef) -> CFDictionary {
  var keys: [UnsafeRawPointer?] = [UnsafeRawPointer(Unmanaged.passUnretained(key).toOpaque())]
  var values: [UnsafeRawPointer?] = [UnsafeRawPointer(Unmanaged.passUnretained(value).toOpaque())]
  var keyCallBacks = kCFTypeDictionaryKeyCallBacks
  var valueCallBacks = kCFTypeDictionaryValueCallBacks
  return CFDictionaryCreate(nil, &keys, &values, 1, &keyCallBacks, &valueCallBacks)
}

func stringValue(_ dictionary: CFDictionary, _ key: CFString) -> String? {
  guard let raw = CFDictionaryGetValue(dictionary, Unmanaged.passUnretained(key).toOpaque()) else { return nil }
  let value = Unmanaged<CFTypeRef>.fromOpaque(raw).takeUnretainedValue()
  guard CFGetTypeID(value) == CFStringGetTypeID() else { return nil }
  let string = unsafeDowncast(value, to: CFString.self)
  let size = CFStringGetMaximumSizeForEncoding(CFStringGetLength(string), utf8Encoding) + 1
  var buffer = [CChar](repeating: 0, count: size)
  guard CFStringGetCString(string, &buffer, size, utf8Encoding) else { return nil }
  return String(cString: buffer)
}

func checkCode(_ attributes: CFDictionary, requirement text: String) -> (code: SecCode?, valid: Bool) {
  var code: SecCode?
  guard SecCodeCopyGuestWithAttributes(nil, attributes, SecCSFlags(), &code) == errSecSuccess, let code else {
    return (nil, false)
  }
  var requirement: SecRequirement?
  guard SecRequirementCreateWithString(cfString(text), SecCSFlags(), &requirement) == errSecSuccess,
    let requirement
  else { return (code, false) }
  return (code, SecCodeCheckValidity(code, SecCSFlags(), requirement) == errSecSuccess)
}

func signingSummary(_ code: SecCode) -> String {
  var staticCode: SecStaticCode?
  guard SecCodeCopyStaticCode(code, SecCSFlags(), &staticCode) == errSecSuccess, let staticCode else {
    return "unsigned"
  }
  var information: CFDictionary?
  guard
    SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &information)
      == errSecSuccess,
    let information
  else { return "unreadable" }
  let identifier = stringValue(information, kSecCodeInfoIdentifier) ?? "-"
  let team = stringValue(information, kSecCodeInfoTeamIdentifier) ?? "-"
  return "identifier=\(identifier) team=\(team)"
}

/// A hint for the app: is the parent Google Chrome, signed by Google? The pid can be reused, so this is
/// a barrier and not a proof; the person's choice of the words is what pairs.
func parentKind() -> String {
  var parent = Int32(getppid())
  guard let number = CFNumberCreate(nil, .sInt32Type, &parent) else { return "unknown" }
  let (code, valid) = checkCode(cfDictionary(kSecGuestAttributePid, number), requirement: googleChromeRequirement)
  guard let code else { return "unknown" }
  note("parent \(signingSummary(code)) chrome=\(valid)")
  return valid ? "google-chrome" : "other"
}

/// The process on the other side of a connected Unix socket meets the app requirement of this build.
func peerIsApp(_ fd: Int32) -> Bool {
  var token = audit_token_t()
  var length = socklen_t(MemoryLayout<audit_token_t>.size)
  guard getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &length) == 0 else {
    note("peer token unreadable errno=\(errno)")
    return false
  }
  guard let requirement = HostConfig.appRequirement else {
    note("peer check skipped (development build)")
    return true
  }
  guard
    let data = withUnsafeBytes(of: &token, { raw in
      CFDataCreate(nil, raw.bindMemory(to: UInt8.self).baseAddress, raw.count)
    })
  else { return false }
  let (code, valid) = checkCode(cfDictionary(kSecGuestAttributeAudit, data), requirement: requirement)
  note("peer \(code.map(signingSummary) ?? "no code") valid=\(valid)")
  return valid
}

// MARK: - Frames

enum ReadResult {
  case wouldBlock
  case frame([UInt8])
  case closed
  case tooLarge
  case empty
}

/// Reads frames from a non-blocking descriptor. The length is checked against the cap before any
/// buffer for the body is made, so an announced size never allocates memory by itself.
final class FrameReader {
  let fd: Int32
  let cap: Int
  private var header = [UInt8](repeating: 0, count: 4)
  private var headerFilled = 0
  private var body: [UInt8] = []
  private var bodyFilled = 0
  /// A frame is under way: some bytes of it have been read.
  var inFrame: Bool { headerFilled > 0 }
  /// The app connection that was online when the current frame started, if any.
  var startedEpoch: Int? = nil

  init(fd: Int32, cap: Int) {
    self.fd = fd
    self.cap = cap
  }

  func read(epoch: Int?) -> ReadResult {
    while true {
      if headerFilled < 4 {
        let count = header.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress! + headerFilled, 4 - headerFilled) }
        if count == 0 { return .closed }
        if count < 0 { return errno == EAGAIN || errno == EINTR ? .wouldBlock : .closed }
        if headerFilled == 0 { startedEpoch = epoch }
        headerFilled += count
        if headerFilled < 4 { continue }
        let length = Int(header.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) })
        if length == 0 { return .empty }
        if length > cap { return .tooLarge }
        body = [UInt8](repeating: 0, count: length)
        bodyFilled = 0
      }
      let wanted = body.count - bodyFilled
      let count = body.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress! + bodyFilled, wanted) }
      if count == 0 { return .closed }
      if count < 0 { return errno == EAGAIN || errno == EINTR ? .wouldBlock : .closed }
      bodyFilled += count
      if bodyFilled == body.count {
        let frame = body
        body = []
        headerFilled = 0
        bodyFilled = 0
        return .frame(frame)
      }
    }
  }
}

/// One frame on its way out, written as far as the descriptor takes it.
final class FrameWriter {
  private var bytes: [UInt8]
  private var written = 0

  init(_ body: [UInt8]) {
    var length = UInt32(body.count)
    bytes = withUnsafeBytes(of: &length) { Array($0) } + body
  }

  enum Result { case done, wouldBlock, failed }

  func write(to fd: Int32) -> Result {
    while written < bytes.count {
      let count = bytes.withUnsafeBytes { Darwin.write(fd, $0.baseAddress! + written, bytes.count - written) }
      if count < 0 { return errno == EAGAIN || errno == EINTR ? .wouldBlock : .failed }
      written += count
    }
    return .done
  }
}

func ascii(_ text: String) -> [UInt8] { Array(text.utf8) }

let handshakePrefix = ascii("{\"k\":\"")
let sealedPrefix = ascii("{\"v\":1,")

func startsWith(_ bytes: [UInt8], _ prefix: [UInt8]) -> Bool {
  bytes.count >= prefix.count && Array(bytes[0..<prefix.count]) == prefix
}

func setNonBlocking(_ fd: Int32) {
  let flags = fcntl(fd, F_GETFL)
  _ = fcntl(fd, F_SETFL, flags | O_NONBLOCK)
}

// MARK: - The bridge

final class Bridge {
  let path: String
  let folder: String
  let chromeIn = FrameReader(fd: STDIN_FILENO, cap: maxFrameToApp)
  var toChrome: [FrameWriter] = []
  var app: Int32 = -1
  var appIn: FrameReader? = nil
  var toApp: FrameWriter? = nil
  /// Counts app connections; a frame from Chrome goes only to the connection that was online when it began.
  var epoch = 0
  var online = false
  var reportedOnline: Bool? = nil
  var offlineSince = now()
  var nextRetry = now()
  var quickRetries: [Double] = []
  var watch: Int32 = -1
  var watchedFolder: Int32 = -1

  init(path: String) {
    self.path = path
    folder = folderOf(path)
  }

  func sendStatus() {
    guard reportedOnline != online else { return }
    reportedOnline = online
    toChrome.append(FrameWriter(ascii("{\"h\":\"status\",\"app\":\"\(online ? "online" : "offline")\"}")))
  }

  /// `quick` after a plain close: the app may still listen (it ends a connection to renew keys, or to
  /// let an extension that it refused try again), so the host reconnects at once. After a frame that the
  /// host refused, it waits the safety retry.
  func closeApp(_ reason: String, quick: Bool) {
    if app >= 0 { close(app) }
    app = -1
    appIn = nil
    toApp = nil
    if online { offlineSince = now() }
    online = false
    nextRetry = now() + offlineRetrySeconds
    quickRetries = quick ? quickRetryDelays.map { now() + 0.05 + $0 } : []
    note("app offline: \(reason)")
    sendStatus()
  }

  /// Watches the socket folder, so a new socket is seen at once.
  func ensureWatch() {
    if watch < 0 { watch = kqueue() }
    guard watchedFolder < 0, watch >= 0 else { return }
    let fd = open(folder, O_EVTONLY)
    guard fd >= 0 else { return }
    watchedFolder = fd
    var change = kevent(
      ident: UInt(fd), filter: Int16(EVFILT_VNODE), flags: UInt16(EV_ADD | EV_CLEAR),
      fflags: UInt32(NOTE_WRITE | NOTE_DELETE | NOTE_RENAME | NOTE_REVOKE), data: 0, udata: nil)
    _ = kevent(watch, &change, 1, nil, 0, nil)
  }

  /// Drains the folder events; a deleted or moved folder is watched again on the next retry.
  func folderChanged() {
    var events = Array<kevent>(
      repeating: kevent(ident: 0, filter: 0, flags: 0, fflags: 0, data: 0, udata: nil), count: 8)
    var zero = timespec()
    let count = kevent(watch, nil, 0, &events, Int32(events.count), &zero)
    for index in 0..<max(0, Int(count)) where events[index].fflags & UInt32(NOTE_DELETE | NOTE_RENAME | NOTE_REVOKE) != 0 {
      close(watchedFolder)
      watchedFolder = -1
    }
    quickRetries = quickRetryDelays.map { now() + $0 }
  }

  func tryConnect() {
    guard !online else { return }
    ensureWatch()
    guard isPrivateFolder(folder) else {
      note("socket folder missing or not private")
      return
    }
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { return }
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8)
    guard bytes.count < MemoryLayout.size(ofValue: address.sun_path) else {
      close(fd)
      return
    }
    withUnsafeMutableBytes(of: &address.sun_path) { raw in
      for (index, byte) in bytes.enumerated() { raw[index] = byte }
      raw[bytes.count] = 0
    }
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    let connected = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }
    guard connected == 0 else {
      close(fd)
      return
    }
    var noSigPipe: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))
    guard peerIsApp(fd) else {
      close(fd)
      nextRetry = now() + offlineRetrySeconds
      return
    }
    setNonBlocking(fd)
    app = fd
    appIn = FrameReader(fd: fd, cap: maxFrameToChrome)
    epoch += 1
    online = true
    quickRetries = []
    note("app online")
    sendStatus()
  }

  func run() -> Never {
    toChrome.append(
      FrameWriter(
        ascii("{\"h\":\"hello\",\"hostVersion\":\"\(HostConfig.hostVersion)\",\"pid\":\(getpid()),\"parent\":\"\(parentKind())\"}")))
    tryConnect()
    sendStatus()
    while true {
      var fds: [pollfd] = []
      // Chrome is read only when the frame before has gone to the app (or the app is away and the
      // frame is dropped), and the app only when the frame before has gone to Chrome.
      if toApp == nil { fds.append(pollfd(fd: STDIN_FILENO, events: Int16(POLLIN), revents: 0)) }
      if !toChrome.isEmpty { fds.append(pollfd(fd: STDOUT_FILENO, events: Int16(POLLOUT), revents: 0)) }
      if app >= 0 {
        var events: Int32 = 0
        if toChrome.isEmpty { events |= POLLIN }
        if toApp != nil { events |= POLLOUT }
        // With nothing to ask, the socket stays out of the set: poll reports a hang-up even for no
        // events, and the loop would spin until Chrome takes the frame that waits for it.
        if events != 0 { fds.append(pollfd(fd: app, events: Int16(events), revents: 0)) }
      }
      if !online && watch >= 0 { fds.append(pollfd(fd: watch, events: Int16(POLLIN), revents: 0)) }
      var timeout: Int32 = -1
      if !online {
        let due = ([nextRetry, offlineSince + offlineExitSeconds] + quickRetries).min() ?? nextRetry
        timeout = Int32(max(0, min(Double(Int32.max) / 1000, (due - now()) * 1000)).rounded(.up))
      }
      let ready = poll(&fds, nfds_t(fds.count), timeout)
      if ready < 0 && errno != EINTR { exit(5) }
      for entry in fds where entry.revents != 0 {
        switch entry.fd {
        case STDIN_FILENO: readChrome()
        case STDOUT_FILENO: writeChrome()
        case watch: folderChanged()
        default: serviceApp(entry.revents)
        }
      }
      if !online {
        let time = now()
        if time - offlineSince >= offlineExitSeconds {
          note("app away for 24 hours")
          exit(3)
        }
        if time >= nextRetry || quickRetries.contains(where: { $0 <= time }) {
          quickRetries.removeAll { $0 <= time }
          if time >= nextRetry { nextRetry = time + offlineRetrySeconds }
          tryConnect()
        }
      }
    }
  }

  func readChrome() {
    while toApp == nil {
      switch chromeIn.read(epoch: online ? epoch : nil) {
      case .wouldBlock: return
      case .closed:
        note("chrome closed the port")
        exit(0)
      case .tooLarge, .empty:
        note("chrome sent a frame the host refuses")
        exit(4)
      case .frame(let body):
        // A frame that began under another app connection, or while the app was away, belongs to no
        // session the app holds now: it is dropped.
        if online && chromeIn.startedEpoch == epoch { toApp = FrameWriter(body) } else { note("dropped a frame from chrome") }
        if toApp != nil { writeApp() }
      }
    }
  }

  func writeChrome() {
    while let first = toChrome.first {
      switch first.write(to: STDOUT_FILENO) {
      case .done: toChrome.removeFirst()
      case .wouldBlock: return
      case .failed: exit(5)
      }
    }
  }

  func writeApp() {
    guard let writer = toApp, app >= 0 else { return }
    switch writer.write(to: app) {
    case .done: toApp = nil
    case .wouldBlock: return
    case .failed: closeApp("write failed", quick: true)
    }
  }

  func serviceApp(_ events: Int16) {
    if events & Int16(POLLOUT) != 0 { writeApp() }
    guard app >= 0, let reader = appIn else { return }
    if events & Int16(POLLIN | POLLHUP | POLLERR) == 0 { return }
    while toChrome.isEmpty {
      switch reader.read(epoch: epoch) {
      case .wouldBlock: return
      case .closed:
        closeApp("closed", quick: true)
        return
      case .tooLarge, .empty:
        closeApp("frame refused", quick: false)
        return
      case .frame(let body):
        guard startsWith(body, handshakePrefix) || startsWith(body, sealedPrefix) else {
          closeApp("frame is not a handshake or sealed frame", quick: false)
          return
        }
        toChrome.append(FrameWriter(body))
        writeChrome()
      }
    }
  }
}

// MARK: - Start

signal(SIGPIPE, SIG_IGN)
let arguments = CommandLine.arguments
guard arguments.count >= 2, arguments[1] == HostConfig.allowedOrigin else { exit(2) }
guard let path = socketPath() else { exit(6) }
if HostConfig.diagnostics, isPrivateFolder(folderOf(path)) {
  diagnosticsFd = open(folderOf(path) + "/host-diagnostics.log", O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW, 0o600)
}
note("start channel=\(HostConfig.channel)")
setNonBlocking(STDIN_FILENO)
setNonBlocking(STDOUT_FILENO)
Bridge(path: path).run()
