# Offline sync execution evidence

Base: de816dc42bc96fe04d06f1c46304de3fbfb5b85b. Local implementation branch feature/offline-sync. Main and experimental WIP refs remain unchanged.

## P0.1 baseline, November 24 2026

Executed with Node22.23.5 and disposable local PostgreSQL/auth shim, never hosted Supabase:
- `python tests/run.py`:85passed,0failed.
- `cd app && npm test`:13files,141passed,0failed.
- `cd app && npm run typecheck`:passed.
- Server suite with only0001–0013+0017:63passed,22failed of85. Expected compatibility failures, not a supported runtime:0014lifecycle policy/identity tests,0015membership,0016org reads,0018deleted completion,0019checked update,0020checked status/delete. One exact-grants lint expects APIs not present in that subset. Do not install unapproved0014or downgrade to unchecked writes to hide these failures.

Old test-output text files are historical snapshots, not current aggregate results. Latest above replaces their use as the baseline. Raw output retained outside repository in local execution evidence. Native/device/hosted tests not run.

## RPC compatibility

| Client use | Local server source | Old approved hosted baseline0001–0013 |
|---|---|---|
| Auth/profile/ordinary personal create/pull/receipts |0001–0013 |Source-compatible base, not reverified hosted |
| Shell my_membership |0015 |Missing |
| Org list reads |0016 |Missing |
| Sync floor status |0017 |Missing |
| Old complete deleted-task refusal |0018 |Missing hardened behavior |
| Checked edits |0019 |Missing, must remain queued |
| Checked complete/reopen/delete |0020 |Missing, must remain queued |
| Account deletion/lifecycle policy |0014 |Separate unapproved policy proposal; not an offline deployment prerequisite to bundle silently |

Main contains all these local proposals, but no migration approval or hosted installation is implied. Local full-suite tests use the complete proposal set for coverage; subset failures are kept visible. No cleanup/purge job is enabled. No new framework required.

## P0.2 lifecycle

Account/environment-partitioned SQLite names; dedicated account-token transport checks identity at token acquisition and before/after every response. Store disposal stops timers/subscribers and closes the owned database after inflight work settles. Existing unsent rows stay durable. Boot kicks queue without new edits. Unauthorized queues pause without timer spin, same-account session refresh resumes, foreground resumes, foreground-only60second sync covers reconnect without adding a network dependency. Personal cache remains available on membership network failure without granting cached organization authority. Auth restoration cannot overwrite a newer identity event.

App regression:146passed,0failed/14files; typecheckpassed. Added5local lifecycle scenarios (partition, account switch/late reply, durable cold boot, auth pause/resume, disposal). Initial regression failures fixed before commit. Device event wiring/UI pixel checks remain unverified. Airplane-mode is transport-simulated, not physical. Old unnamespaced `tf_<uid>.db` is not auto-adopted across environments; its data is left intact, manual verified-environment migration remains required if such a pre-release database exists. No encryption claim: SQLite remains OS-sandboxed plaintext, auth secrets use existing secure storage.

## P0.3 mutation safety

Dependencies now explicitly chain same-entity ops and child creation to pending parent operations. Own repeated edits use the immediately preceding local value, not an obsolete initial base. Missing nullable values are explicit nulls. Transmitted args/opID/RPC are SQLite-trigger-immutable, including crash-recovered/requeued operations. Version chaining only touches never-transmitted deletes. Terminal stale refusals cannot be retried as the same op; explicit resolution uses fresh operation IDs.

New local-only0021tightens checked edits to require every patched field base and checked deletion to compare exact descendant IDs+versions, not merely count/sum. Dirty subtrees send impossible tokens instead of skipping protection. No-subtree callers are refused if children exist. Null root versions refuse. Deletion takes a table writer lock to close descendant insert/edit/reparent races. This is deliberately correctness-first and coarse; potential throughput/deadlock/retry cost requires load evaluation before hosted approval. Existing0001–0020files unchanged; no experimental branch imported.

Executed88serverpassed,151apppassed/15files,typecheckpassed. Added strict-base, exact-member/omittedguard/nullbase, deterministic uncommitteddescendantwriter lock tests; local own-op/dependency, transmittedimmutability, lostresponsebyteidentity, dirtysubtreerefusal, terminalretry tests. Two old assertions updated because dependent ops are now rejected/resumed by propagation rather than separate network sends, without weakening outcome assertions. No hosted SQL ran.

## P1.1 recovery

Normal sync, manual repair and conflict refresh share a serialized queue. Engine disposal blocks even late successful pull responses. Auth identity changes invalidate a bound worker immediately, including A→B→A; rendered personal/membership state is owner-tagged to prevent a one-render old-account leak. Manual resync fetches into bounded staging (100krowlimit) before atomic replacement, keeping all pending intents and the whole old cache if network/disk fails. Normal cursor and pages remain transactional. Quick integrity/schema-version checks refuse corrupt/newer files without resetting them. Local write failure rolls back row+outbox and retains composer text with a recovery message. Initial database-open failures show an explicit recovery screen, never create a blank replacement. Storage remains preserved for manual recovery, not automatically repaired.

Local0022proposal refuses new children below deleted parents, closing queued-child resurrection.90/90server,160/160app/16files,typecheckpassed. Added failedresync/cache, serialrepair, latepull/disposal, simulateddiskfull, atomicrepairrollback,pendingpreservation,newerschemarefusal,expiredintentretention,backoffnotnetwork tests. Existing file-backed restart/SIGKILL/page-interruption tests remain green. One typecheck was killed by local-memory pressure from orphan disposable PG processes; cleaned those safely, fixed bridge SIGTERMcleanup+awaitedshutdown, subsequent fullruns/typecheckpass, no orphan postmasters left.

Browser preview inspection,390x844 EN/AR: offline personal shell reachable, storage recovery messages/buttons readable, failed-submit draft retained, no horizontaloverflow/JSerrors. These are actual React components with synthetic auth/store, not native or hosted evidence. Native font rendering/event wiring/keychain/expoSQLite/realflightmode remain unverified.

## P1.2 retention/security

See OFFLINE_RETENTION_SECURITY.md for the local review, finite-retention proof obligations and remaining native/hosted gates. Purge/cleanup remains absent. Added local0023capability check so new clients never trust old checked-delete semantics solely from RPCname presence; destructive intent stays queued on oldhostedservers. No migration applied beyond disposable tests. Native coldstart now shows personalcache while membership request is pending, not only after a network error. Unauthorized foregroundpolls do not resume until refresh/explicitretry.

Regression90serverpassed,164apppassed/16files,typecheckpassed (final executed below). Added oldservercapability preflight, authrestorationrace, ownrepeatedfieldedit and dirtydescendantactualPG tests. Browser screenshots are localsyntheticcomponentevidence only. Remaining pre-releaseDB import, native/hosted validation, encryptionpolicy and safe snapshot/purge design remain open, not silently passed.

## Additional local review after the first checkpoint

First checkpoint33d626bwas not the end of locally executable proof.12concurrentcreate/edit/deleteoperations across4accountsexposed real table/receipt/row lock-order deadlocks. New local0024proposal takes one global personal-RPC advisory lock before receipt/row/table acquisition. Afterfix20/20repetitions passed (240concurrentRPCattempts plus same-IDreplays), no deadlock/unresolvedreceipt/orphanlivechild observed. Per12optest~0.1s onthislocalfixture, nothostedcapacity. Globalserializationis intentional, reviewbeforedeployment.

Added deterministic childinsertwaitingbehinddelete, actualPGcounterexampleto unsafe max-purged-xidfloor, interrupted200rowresync and cursorfloorrepairwithpendingintent. Fullregression93serverpassed,167apppassed/16files,typecheckpassed. Purge remainsdisabled; this proves a badwatermarkunsafe, not a completepurgeprotocolsafe.

## Targeted local security follow-up

Added mocked actualaccount-token-callback tests: anotheruser/nullsession/getSessionerrorcannotprovidecredentials; sameuserrefreshcan. Actualcorruptfiletestpreservesbytesandrefusesopenwithoutreset. URLguardreviewfoundprefixregexacceptedlookalikehosts. Replacedwithparsedbare-origin/exacthostnamevalidation, addedlocalhost/Supabaselookalike/credential/path/querynegativecases. Fullapp171passed/17files,typecheckpassed. Nooutboundconnectionmadebythesemockedtests. These do notreplacehostedtokenorKeychainverification.

## Pull/status contract hardening

Added validation before anypagewrites:object/rowshape,boundeddecimalxid,strictascending(xid,id),rowsbelowhorizon,pinnedhorizon,limit,lastrow/cursoragreement,empty-pagecursorandstatusboolean/floor/capabilitytypes. Invalidsecondpagekeepspreviousvalidpagecursor; fullresyncvalidatesbeforecachedelete. One synthetic200rowfixturewasorderedlexicographicallytofollowrealservercontract. Regression93server/176app19files,typecheckpassed. Added13malformedpagecasespluspinnedhorizon/nonadvance/shortpage/statuscases. Alsoseeded1000stepoutboxrestart/retrymodelpassed. Localonly,notnewhostedverification.

## Mutation-response and mixed real-database replay proof

Malformed mutation responses now fail as retryable server transport errors before ack/reject, retaining the original intent/ID. Negative cases cover null/array/missing/wrongtypedok, missingdata, malformederrorcode/message. Added seededmixedrealPG4account/48taskcreate/edit/deleteworkload with exactsame-ID replay after every simulatedlostresponse, checkingrowversionsandnoreceipthalfstates. Full94server/177app19files,typecheckpassed. Direct maintenanceSQLdoesnotparticipateinpersonalRPCadvisorylock: maintenance/deploymentmustquiescewritersorusetheprovedlockorder,notbeadvertisedascoveredbyRPCstress.

## Missing capability transport guard

Follow-upafter16:54handoff: optionalRpcClient.statuscouldbypassdeletepreflightwhenomitted. Nowdeleteworkersfailclosedwithserver-update-requiredwhenstatusmethoditselfisabsent;sameintentremainsqueued,nottransmitted. Newnegativecasepassed.Fullapp178passed/19files,typecheckpassed;lastserver94passedunchangedSQL.

## Auth mutation race follow-up

Late sign-in completion could still restore state after logout even though startup restoration was guarded. Extended authrevision/disposal checks to sign-in/signup/resend; signout clearsbusyimmediately,identityeventclearsbusy,disposeinvalidatespendingresponses. Deterministiclogoutduringpendingloginanddisposecasesadded;fullapp180passed/19files,typecheckpassed. NativeSDKauth-eventbehaviorstillrequiresrealverification.
