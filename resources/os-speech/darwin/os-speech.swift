// The system dictation of macOS: one finished WAV file in, its transcript out.
//
// The app opens this as a tiny background application, so the Speech framework stays out of the
// main process and the speech recognition permission belongs to this bundle. The system asks for
// it the first time, naming "Builders Bot system dictation". A plain child process of the app
// aborts in TCC when it asks for the permission.
//
// The answer goes to the file of `--out`, or to stdout. A failure goes to `--err` as
// `code: message`, or to stderr. `--status` only reads the permission, without asking for it.
//
// Exit codes: 0 with the text; 3 permission denied; 4 restricted; 5 language unsupported;
// 6 recognizer unavailable; 7 nothing was said; 1 anything else.

import Foundation
import Speech

var language = "automatic"
var path = ""
var outputPath = ""
var errorPath = ""
var statusOnly = false

func write(_ text: String, to path: String) {
    try? text.write(toFile: path, atomically: true, encoding: .utf8)
}

func fail(_ code: String, _ message: String, _ status: Int32) -> Never {
    let line = "\(code): \(message)\n"
    if errorPath.isEmpty {
        FileHandle.standardError.write(Data(line.utf8))
    } else {
        write(line, to: errorPath)
    }
    exit(status)
}

func succeed(_ text: String) -> Never {
    if outputPath.isEmpty {
        print(text)
    } else {
        write(text, to: outputPath)
    }
    exit(0)
}

func waitForRunLoop(until deadline: Date, while pending: () -> Bool) {
    // The Speech callbacks of macOS arrive on the main run loop, so the process has to run it
    // instead of blocking on a semaphore.
    while pending() && Date() < deadline {
        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
    }
}

var index = 1
while index < CommandLine.arguments.count {
    switch CommandLine.arguments[index] {
    case "--language":
        index += 1
        if index < CommandLine.arguments.count { language = CommandLine.arguments[index] }
    case "--file":
        index += 1
        if index < CommandLine.arguments.count { path = CommandLine.arguments[index] }
    case "--out":
        index += 1
        if index < CommandLine.arguments.count { outputPath = CommandLine.arguments[index] }
    case "--err":
        index += 1
        if index < CommandLine.arguments.count { errorPath = CommandLine.arguments[index] }
    case "--status":
        statusOnly = true
    default:
        path = CommandLine.arguments[index]
    }
    index += 1
}

func authorization() -> SFSpeechRecognizerAuthorizationStatus {
    SFSpeechRecognizer.authorizationStatus()
}

func askAuthorization() -> SFSpeechRecognizerAuthorizationStatus {
    var settled = false
    SFSpeechRecognizer.requestAuthorization { _ in settled = true }
    waitForRunLoop(until: Date().addingTimeInterval(60), while: { !settled })
    return authorization()
}

func checkAuthorization() -> SFSpeechRecognizerAuthorizationStatus {
    let current = authorization()
    if current == .notDetermined && !statusOnly { return askAuthorization() }
    return current
}

switch checkAuthorization() {
case .authorized: break
case .denied: fail("permission", "Speech recognition is denied.", 3)
case .restricted: fail("permission", "Speech recognition is restricted.", 4)
case .notDetermined: fail("permission", "Speech recognition was not granted yet.", 3)
@unknown default: fail("permission", "Speech recognition is not authorized.", 3)
}

if statusOnly { succeed("authorized") }

guard !path.isEmpty else { fail("usage", "No recording was given.", 1) }
guard FileManager.default.fileExists(atPath: path) else { fail("usage", "The recording is gone.", 1) }

// `automatic` follows the language of the system; the settings send an ISO 639 code otherwise.
// `jw` is Whisper's code for Javanese, which the Speech framework knows as `jv`.
let tag = language == "automatic" ? Locale.current.identifier : language
let locale = Locale(identifier: tag == "jw" ? "jv" : tag)
guard let recognizer = SFSpeechRecognizer(locale: locale) else {
    fail("language", "The system does not recognize this language.", 5)
}
guard recognizer.isAvailable else { fail("unavailable", "The recognizer is not available.", 6) }
// The audio stays on this Mac, as the usage descriptions of the app say: recognition on the server
// of Apple is never used. A language without its on-device asset answers `language`, so `auto`
// moves to the voice model of the app.
guard recognizer.supportsOnDeviceRecognition else {
    fail("language", "This language has no speech recognition on this Mac.", 5)
}

/// One pass over the recording, on device only. A Mac with Dictation off fails here.
func recognize() -> (text: String, failure: Error?) {
    let request = SFSpeechURLRecognitionRequest(url: URL(fileURLWithPath: path))
    request.requiresOnDeviceRecognition = true
    request.shouldReportPartialResults = false

    var text = ""
    var failure: Error?
    var finished = false
    let deadline = Date().addingTimeInterval(120)
    recognizer.recognitionTask(with: request) { result, error in
        if let error {
            failure = error
            finished = true
            return
        }
        guard let result else { return }
        text = result.bestTranscription.formattedString
        if result.isFinal { finished = true }
    }
    waitForRunLoop(until: deadline, while: { !finished })
    if !finished && failure == nil { failure = NSError(domain: "os-speech", code: 1) }
    return (text, failure)
}

let outcome = recognize()

let transcript = outcome.text.trimmingCharacters(in: .whitespacesAndNewlines)
if transcript.isEmpty {
    fail("recognize", outcome.failure?.localizedDescription ?? "Nothing was recognized.", 1)
}
succeed(transcript)
