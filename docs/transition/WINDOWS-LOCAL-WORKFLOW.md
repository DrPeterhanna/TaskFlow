# Windows local development transition

24 November 2026. Target: Peter's Lenovo LOQ, Android Studio, Galaxy A56 and emulator.

## What is possible now

The source package opens as a normal native Android Studio project. You can edit
and build it on Windows without WSL. The backend is separate and uses WSL2.
There is no connected, supported way for this assistant to edit or execute on
your laptop right now. WhatsApp is communication, not laptop access. Nothing in
this package installs remote access, a command listener or an unattended bridge.
I can prepare code, patches, commands and review the results you choose to share.
I cannot truthfully promise live laptop edits, debugging or deployment from chat.

## Recommended first session, no AI tool dependency

1. Keep any existing TaskFlow folder unchanged. Extract into C:\TF-Transition.
2. Use the included offline Git bundle as GIT-RECOVERY.md describes. Work only
   on local branch windows-transition. Do not push or change approved branches.
3. Follow OPEN-IN-ANDROID-STUDIO.md. Install Git for Windows, Node22.23.5,
   JDK17, Android Studio and the exact SDK/NDK/CMake components listed there.
4. Open app\android, sync Gradle, build ARM64 and run on the Galaxy by USB.
   No WSL/backend needed to reach the setup-required screen.
5. Capture the exact first build or launch error if one occurs. Do not reset
   Git, uninstall the app or clear SQLite to make an error disappear.
6. Set up the separate backend runtime after native build is confirmed. WSL2
   Ubuntu22.04/24.04 and Python3.10-3.12 are supported packaging targets.
7. Enable local build configuration and USB reverse, then sign in and sync.
8. Create an x86_64 emulator system image if the laptop supports it. Override
   reactNativeArchitectures=x86_64 for that build. Test phone and emulator
   separately; a successful ARM64 phone build proves neither emulator runtime
   nor Windows virtualization readiness.

## A separate local coding tool can edit the same files

This is an alternative product, not this assistant moving onto your laptop.
No tool or model has been installed or run on the Lenovo, so compatibility and
quality are still open. Two practical routes are:

| Route | Fit | Limits |
| --- | --- | --- |
| Android Studio local model provider with Ollama | Keeps Android Studio as the only IDE, local inference, source visible in the same project | Latest IDE/provider UI required; official docs warn some agent features do not work with local models. Does not prove full build/debug automation. |
| Aider terminal plus Ollama on Windows | A separate coding tool edits files in the local Git checkout; Android Studio shows disk changes; documented /run and /test can invoke Gradle/tests | Separate terminal and model process; local-model quality/latency/context limits; native GUI debugging still belongs to Android Studio. |

Start with manual build proof, then try a small harmless edit with a checkpoint.
Do not choose an AI tool before checking RAM, GPU/VRAM, disk and Windows version.
Lenovo LOQ is a product family, not a verified hardware specification. Peter must
provide those specs or inspect them locally. Android Studio+emulator+Gradle+WSL
already consume memory. A model's download size is not its working RAM/VRAM.

Ollama's Windows docs require Windows10 22H2+ and list GPU/driver requirements.
They specify at least4GB for the software plus model storage. Its local API is
127.0.0.1:11434. Keep it loopback-only. Do not enable cloud models or add paid API
keys, subscriptions, hosted inference or tunnels. Initial downloads need network
and disk space; local execution still uses the laptop's power and memory.
Ollama documents OLLAMA_NO_CLOUD=1 to disable cloud models and web search;
restart after setting it and verify the log says cloud is disabled. No automatic
configuration is applied by this package.

A concrete no-provider-fee trial option is Aider (Apache2.0) + Ollama (MIT) +
Qwen2.5-Coder7B Instruct (Apache2.0). The observed Ollama tag download is4.7GB.
That is a trial candidate, not a claim it fits or performs well on this Lenovo.
Context memory and Android tooling add to the requirement. A smaller model or
CPU inference may be possible but slower/weaker. Do not download a large model
until hardware/free disk are checked. Model selection is deferred to that check.
For Studio Agent Mode choose a tool-use-trained model; not every coding model
supports that protocol. This Qwen candidate is for the Aider route, not a promise
of Studio Agent Mode compatibility.

Aider documents the local provider shape ollama_chat/<model>, supports Windows,
and exposes /run and /test commands. Run it in the SAME windows-transition
checkout as Android Studio. Let Peter approve shell commands and inspect diffs.
Do not run an unattended free-form shell, automatically accept deletion/reset,
or let a model execute hosted migrations. No background WhatsApp command relay.

## Minimal install list by purpose

Always: Android Studio, Git for Windows, Node22.23.5, JDK17, SDK36,
Build-Tools36.0.0, platform-tools, NDK27.1.12297006, CMake3.22.1.
Phone: USB cable, Developer options/USB debugging, RSA approval on phone;
Windows USB driver may be needed if adb cannot detect it.
Emulator: one x86_64 Android image, virtualization support configured locally.
Backend only: WSL2, Ubuntu22.04/24.04, python3-venv, included runtime archives.
Optional separate AI: Ollama, compatible local model, and either latest Studio
local-provider support or Aider's isolated installer/Python runtime.
No automatic installation scripts for optional AI are included.

## Independent work vs your participation

Prepared independently: native source/config/lockfile, known-good Linux ARM64
artifact, setup/connection scripts, local Auth backend, test evidence, offline
sanitized Git checkpoints, rollback and this plan.
Needs Peter: install prerequisites/WSL if wanted, approve USB, choose a NEW local
folder, open/build/run on Windows, report actual errors, share hardware specs,
install/try optional local AI, validate actual phone/emulator persistence/sync.
Needs a future supported connection: this assistant directly executing on the
Lenovo. There is no such connection available in the current setup.

## Sources verified for this plan

Android Studio local models, UI steps and feature limits:
https://developer.android.com/studio/gemini/use-a-local-model
Ollama Windows requirements and storage:
https://docs.ollama.com/windows
Ollama local/cloud privacy distinction:
https://docs.ollama.com/faq
Ollama MIT repository license:
https://github.com/ollama/ollama
Aider local Ollama route:
https://aider.chat/docs/llms/ollama.html
Aider shell/test commands:
https://aider.chat/docs/usage/commands.html
Aider Apache2.0 source:
https://github.com/Aider-AI/aider/
Observed model/tag size:
https://ollama.com/library/qwen2.5-coder:7b-instruct
Qwen's size-specific model licenses:
https://qwenlm.github.io/blog/qwen2.5-coder-family/

These are verified documentation capabilities, not a tested installation on your
hardware. No external coding tool was given project access during this research.
