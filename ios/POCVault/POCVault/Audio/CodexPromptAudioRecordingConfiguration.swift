import AVFoundation
import Foundation

struct CodexPromptAudioRecordingConfiguration {
    let category: AVAudioSession.Category
    let mode: AVAudioSession.Mode
    let options: AVAudioSession.CategoryOptions
    let settings: [String: Any]

    static let devicePromptDefaults = CodexPromptAudioRecordingConfiguration(
        category: .record,
        mode: .default,
        options: [],
        settings: [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: 16_000.0,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsNonInterleaved: false
        ]
    )
}
