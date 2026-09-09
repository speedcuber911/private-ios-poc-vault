# Live reviewer workflow screenshots

Captured 2026-08-31 from the native Release app at runtime source
`b2d34d81cc61db51f95a7f04e3de4fa3dea3b86a`, on the dedicated Relay Review
Fresh iPhone simulator (iPhone 17 Pro Max). Each PNG is an unedited
1320 x 2868 `simctl io screenshot` capture, suitable for the 6.9-inch set.
No simulator fixture was enabled. The app used the production account service
and the existing review account's recovered, isolated hosted machine.

1. `01-workspace-results.png`: real Previews results from the hosted machine.
2. `02-working-preview.png`: the actual task-linked localhost page after a
   checklist control was toggled, changing its count from 2 of 3 to 3 of 3.
3. `03-source-task.png`: real persisted starter task and output in native chat.
4. `04-workspace-files.png`: the starter project's real files in Workspaces.
5. `05-data-sharing.png`: actual provider-specific disclosure; Not Now was
   chosen after capture. No AI job was started or provider login fabricated.

The starter is explicitly fictional preloaded content included for all new
hosted machines, not an AI-generated run, handoff or approval. Its HTML artifact,
source files and interactive server are real product inputs. No operator
provider credentials or private project data were copied into the review node.

All five PNGs were visually inspected after capture and uploaded to App Store
Connect on 2026-08-31. Their persisted order is 01, 02, 03, 04, 05. The former
6.9-inch and 6.5-inch screenshot sets were replaced; all smaller iPhone sizes
were verified to use the new 6.9-inch set. Version 1.0 build 49 and all three
subscription/group review items subsequently reached Waiting for Review.
The older sibling `iphone/` set uses a local fixture and should not be used for
this review package. The unrelated `artifacts/app-store-1.0/` remains untouched.
