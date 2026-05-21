import CryptoKit
import XCTest
@testable import POCVault

final class ManifestTests: XCTestCase {
    func testDecodesManifestEntriesWithISO8601Dates() throws {
        let json = """
        {
          "schemaVersion": 1,
          "generatedAt": "2026-05-15T10:00:00Z",
          "pocs": [
            {
              "slug": "smoke",
              "title": "Smoke Test",
              "description": "Small internal POC",
              "url": "https://smoke.pocs.example.com/",
              "updatedAt": "2026-05-14T09:30:00Z",
              "tags": ["demo", "ios"]
            }
          ]
        }
        """.data(using: .utf8)!

        let manifest = try POCManifest.decode(from: json)

        XCTAssertEqual(manifest.version, 1)
        XCTAssertEqual(manifest.entries.first?.id, "smoke")
        XCTAssertEqual(manifest.entries.first?.displayHost, "smoke.pocs.example.com")
        XCTAssertEqual(manifest.entries.first?.requiresClientCertificate, true)
    }

    func testSearchMatchesTitleSummaryAndTags() throws {
        let entry = POCEntry(
            id: "alpha",
            title: "Forecast Console",
            summary: "Demand planner prototype",
            url: URL(string: "https://poc-vault.test/forecast")!,
            updatedAt: nil,
            tags: ["sales"],
            requiresClientCertificate: false
        )

        XCTAssertTrue(entry.matchesSearch("forecast"))
        XCTAssertTrue(entry.matchesSearch("planner"))
        XCTAssertTrue(entry.matchesSearch("sales"))
        XCTAssertFalse(entry.matchesSearch("finance"))
    }

    func testEd25519SignatureVerificationUsesRawPublicKeyBytes() throws {
        let privateKey = Curve25519.Signing.PrivateKey()
        let payload = Data("manifest".utf8)
        let signature = try privateKey.signature(for: payload)

        XCTAssertTrue(
            ManifestClient.verifySignature(
                payload: payload,
                signature: signature,
                publicKeyRawRepresentation: privateKey.publicKey.rawRepresentation
            )
        )
        XCTAssertFalse(
            ManifestClient.verifySignature(
                payload: Data("tampered".utf8),
                signature: signature,
                publicKeyRawRepresentation: privateKey.publicKey.rawRepresentation
            )
        )
    }

    func testCodexErrorSummaryExtractsHttpStatusAndHtmlMessage() throws {
        let rawMessage = """
        Codex request failed with HTTP 404: <!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN"
        "http://www.w3.org/TR/html4/strict.dtd">
        <html>
        <body>
        <h1>Error response</h1>
        <p>Error code: 404</p>
        <p>Message: Not Found.</p>
        <p>Error code explanation: 404 - Nothing matches the given URI.</p>
        </body>
        </html>
        """

        let summary = CodexErrorSummary(message: rawMessage)

        XCTAssertEqual(summary.statusCode, 404)
        XCTAssertEqual(summary.statusLine, "HTTP 404")
        XCTAssertEqual(summary.summary, "Not Found")
        XCTAssertTrue(summary.rawResponse.contains("<!DOCTYPE HTML"))
    }

    func testCodexErrorSummaryUsesPlainTextWhenNoStructuredPayloadExists() throws {
        let summary = CodexErrorSummary(message: "No Codex workspace is available.")

        XCTAssertNil(summary.statusCode)
        XCTAssertEqual(summary.statusLine, "Request failed")
        XCTAssertEqual(summary.summary, "No Codex workspace is available.")
        XCTAssertEqual(summary.rawResponse, "No Codex workspace is available.")
    }

    func testCodexJobDisplayOutputPrefersSingleResultWhenStreamsDuplicate() throws {
        let job = try decodeCodexJob(
            """
            {
              "id": "job-1",
              "status": "succeeded",
              "prompt": "Summarize the repo",
              "result": "The repo is healthy.",
              "stdout": "The repo is healthy.",
              "stderr": "The repo is healthy.",
              "model": "gpt-5.5",
              "reasoningEffort": "high"
            }
            """
        )

        XCTAssertEqual(job.displayOutput, "The repo is healthy.")
        XCTAssertEqual(job.model, "gpt-5.5")
        XCTAssertEqual(job.reasoningEffort, "high")
    }

    func testCodexJobDisplayOutputUsesErrorForFailedJobs() throws {
        let job = try decodeCodexJob(
            """
            {
              "id": "job-2",
              "status": "failed",
              "prompt": "Run tests",
              "stderr": "xcodebuild exited 65",
              "error": "codex exited with code 1"
            }
            """
        )

        XCTAssertEqual(job.displayOutput, "codex exited with code 1")
        XCTAssertTrue(job.rawActivityOutput?.contains("xcodebuild exited 65") == true)
    }

    func testCodexJobDisplayOutputHidesRawCodexTranscript() throws {
        let job = try decodeCodexJob(
            """
            {
              "id": "job-raw",
              "status": "succeeded",
              "prompt": "Check AWS",
              "result": "OpenAI Codex v0.132.0\\nworkdir: /srv/codex-workspaces/scratch\\nexec\\n/bin/bash -lc aws sts get-caller-identity"
            }
            """
        )

        XCTAssertNil(job.displayOutput)
        XCTAssertTrue(job.rawActivityOutput?.contains("OpenAI Codex") == true)
    }

    func testCodexJobDisplayOutputPreviewCapsLargeAnswers() throws {
        let longAnswer = String(repeating: "answer ", count: 10_000)
        let payload = [
            "id": "job-large-answer",
            "status": "succeeded",
            "prompt": "Explain everything",
            "result": longAnswer
        ]
        let data = try JSONSerialization.data(withJSONObject: payload)

        let job = try JSONDecoder().decode(CodexJob.self, from: data)
        let preview = job.displayOutputPreview

        XCTAssertTrue(preview.isTruncated)
        XCTAssertEqual(preview.originalCharacterCount, longAnswer.trimmingCharacters(in: .whitespacesAndNewlines).count)
        XCTAssertLessThan(preview.text.count, longAnswer.count)
        XCTAssertTrue(preview.text.contains("Preview truncated"))
    }

    func testCodexJobRawActivityPreviewDoesNotJoinUnlimitedStreams() throws {
        let hugeStdout = String(repeating: "stdout-line\n", count: 8_000)
        let hugeStderr = String(repeating: "stderr-line\n", count: 8_000)
        let payload = [
            "id": "job-large-activity",
            "status": "failed",
            "prompt": "Run noisy command",
            "stdout": hugeStdout,
            "stderr": hugeStderr,
            "error": "codex exited with code 1"
        ]
        let data = try JSONSerialization.data(withJSONObject: payload)

        let job = try JSONDecoder().decode(CodexJob.self, from: data)
        let preview = job.rawActivityPreview

        XCTAssertTrue(preview.isTruncated)
        XCTAssertGreaterThan(preview.originalCharacterCount, preview.text.count)
        XCTAssertLessThanOrEqual(preview.text.count, CodexDisplayLimits.rawActivityCharacters + 128)
        XCTAssertTrue(preview.text.contains("## Stdout"))
        XCTAssertTrue(preview.text.contains("Preview truncated"))
    }

    func testCodexJobDecodesServerOutputTruncationMetadata() throws {
        let job = try decodeCodexJob(
            """
            {
              "id": "job-output-metadata",
              "status": "succeeded",
              "stdout": "short stdout",
              "stderr": "",
              "result": "short answer",
              "stdoutBytes": 120000,
              "stderrBytes": 0,
              "resultBytes": 250000,
              "stdoutTruncated": true,
              "stderrTruncated": false,
              "resultTruncated": true
            }
            """
        )

        XCTAssertEqual(job.stdoutBytes, 120_000)
        XCTAssertEqual(job.resultBytes, 250_000)
        XCTAssertTrue(job.stdoutTruncated)
        XCTAssertTrue(job.resultTruncated)
        XCTAssertTrue(job.hasTruncatedServerOutput)
    }

    func testCodexSessionDecodesServerShape() throws {
        let session = try JSONDecoder().decode(
            CodexSession.self,
            from: Data(
                """
                {
                  "id": "2026-05-20T12-00-00-abc123",
                  "workspaceId": "scratch",
                  "workspaceName": "Scratch",
                  "cwd": "/tmp/codex-scratch",
                  "timestamp": "2026-05-20T12:00:00Z",
                  "updatedAt": "2026-05-20T12:05:10Z"
                }
                """.utf8
            )
        )

        XCTAssertEqual(session.id, "2026-05-20T12-00-00-abc123")
        XCTAssertEqual(session.workspaceId, "scratch")
        XCTAssertEqual(session.workspaceName, "Scratch")
        XCTAssertEqual(session.cwd, "/tmp/codex-scratch")
        XCTAssertNotNil(session.timestamp)
        XCTAssertNotNil(session.updatedAt)
    }

    func testCodexThreadDecodesServerShapeAndBuildsPreviewText() throws {
        let thread = try JSONDecoder().decode(
            CodexThread.self,
            from: Data(
                """
                {
                  "id": "019e46a3-0000-7000-8000-000000000001",
                  "sessionId": "019e46a3-0000-7000-8000-000000000001",
                  "workspaceId": "scratch",
                  "workspaceName": "Scratch",
                  "cwd": "/srv/codex-workspaces/scratch",
                  "timestamp": "2026-05-20T12:00:00Z",
                  "updatedAt": "2026-05-20T12:05:10Z",
                  "jobCount": 2,
                  "activeJobCount": 1,
                  "lastJobId": "019e46a3-0000-7000-8000-000000000003",
                  "lastJobStatus": "running",
                  "lastPrompt": "continue this thread",
                  "lastResult": "thread answer",
                  "lastError": null,
                  "hasSessionFile": true,
                  "isSmokeTest": true
                }
                """.utf8
            )
        )

        XCTAssertEqual(thread.id, "019e46a3-0000-7000-8000-000000000001")
        XCTAssertEqual(thread.workspaceId, "scratch")
        XCTAssertEqual(thread.workspaceName, "Scratch")
        XCTAssertEqual(thread.jobCount, 2)
        XCTAssertEqual(thread.activeJobCount, 1)
        XCTAssertEqual(thread.lastJobId, "019e46a3-0000-7000-8000-000000000003")
        XCTAssertEqual(thread.lastJobStatus, .running)
        XCTAssertEqual(thread.previewText, "continue this thread")
        XCTAssertTrue(thread.hasActiveJobs)
        XCTAssertTrue(thread.hasSessionFile)
        XCTAssertTrue(thread.isSmokeTest)
    }

    func testCodexJobDecodesResumeSessionID() throws {
        let job = try decodeCodexJob(
            """
            {
              "id": "job-3",
              "workspaceId": "scratch",
              "status": "succeeded",
              "resumeSessionId": "2026-05-20T12-00-00-abc123"
            }
            """
        )

        XCTAssertEqual(job.resumeSessionId, "2026-05-20T12-00-00-abc123")
        XCTAssertEqual(job.threadSessionId, "2026-05-20T12-00-00-abc123")
    }

    func testCodexJobDecodesFreshSessionIDForFollowUp() throws {
        let job = try decodeCodexJob(
            """
            {
              "id": "job-4",
              "workspaceId": "scratch",
              "status": "succeeded",
              "sessionId": "2026-05-21T12-00-00-thread123",
              "logsIncluded": "preview"
            }
            """
        )

        XCTAssertEqual(job.sessionId, "2026-05-21T12-00-00-thread123")
        XCTAssertEqual(job.threadSessionId, "2026-05-21T12-00-00-thread123")
        XCTAssertEqual(job.logsIncluded, "preview")
    }

    func testCodexCreateJobRequestEncodesResumeSessionID() throws {
        let request = CodexCreateJobRequest(
            workspaceId: "scratch",
            prompt: "continue carefully",
            timeoutMs: 120_000,
            model: "gpt-5.5",
            reasoningEffort: "xhigh",
            resumeSessionId: "2026-05-20T12-00-00-abc123"
        )

        let payload = try JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any]

        XCTAssertEqual(payload?["workspaceId"] as? String, "scratch")
        XCTAssertEqual(payload?["prompt"] as? String, "continue carefully")
        XCTAssertEqual(payload?["timeoutMs"] as? Int, 120_000)
        XCTAssertEqual(payload?["model"] as? String, "gpt-5.5")
        XCTAssertEqual(payload?["reasoningEffort"] as? String, "xhigh")
        XCTAssertEqual(payload?["resumeSessionId"] as? String, "2026-05-20T12-00-00-abc123")
    }

    func testCodexViewModelTreatsSwiftCancellationAsNonError() throws {
        XCTAssertTrue(CodexConsoleViewModel.isCancellation(CancellationError()))
    }

    func testCodexViewModelTreatsURLSessionCancellationAsNonError() throws {
        XCTAssertTrue(CodexConsoleViewModel.isCancellation(URLError(.cancelled)))
        XCTAssertFalse(CodexConsoleViewModel.isCancellation(URLError(.notConnectedToInternet)))
    }

    func testClientIdentityStoreResolvesSetupLaunchPassphrase() throws {
        let passphrase = ClientIdentityStore.resolvedImportPassphrase(
            explicitPassphrase: "",
            environment: ["POC_VAULT_P12_PASSPHRASE": " device-secret \n"]
        )

        XCTAssertEqual(passphrase, "device-secret")
    }

    func testClientIdentityStoreRecognizesOnlyTheIPhoneClientCertificateName() throws {
        XCTAssertTrue(ClientIdentityStore.isPreferredClientCertificateName("iphone"))
        XCTAssertTrue(ClientIdentityStore.isPreferredClientCertificateName(" IPHONE "))
        XCTAssertFalse(ClientIdentityStore.isPreferredClientCertificateName("parikshit-mac"))
        XCTAssertFalse(ClientIdentityStore.isPreferredClientCertificateName("client"))
    }

    private func decodeCodexJob(_ json: String) throws -> CodexJob {
        try JSONDecoder().decode(CodexJob.self, from: Data(json.utf8))
    }
}
