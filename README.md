<p align="center">
  <img src="assets/logo.png" alt="Claude Phone" width="200">
</p>

# Claude Phone

Voice interface for Claude Code via SIP. Call your AI, and your AI can call you. Works with 3CX or any SIP-compatible PBX, and can also register directly with a SIP trunk provider.

## What is this?

Claude Phone gives your Claude Code installation a phone number. You can:

- **Inbound**: Call an extension and talk to Claude - run commands, check status, ask questions
- **Outbound**: Your server can call YOU with alerts, then have a conversation about what to do

## What's different in this fork

This fork replaces the original ElevenLabs/Whisper pipeline with pluggable **realtime voice providers** for speech recognition and synthesis, and adds:

- **Selectable voice providers**: **Gemini Live** (default), the **OpenAI Realtime API**, or the original turn-based pipeline (`classic`). Pick a global default with `VOICE_PROVIDER` in `.env`, or per extension with a `"provider"` field in `voice-app/config/devices.json`. A device's `voiceId` must be a voice of its provider (e.g. `Kore`/`Puck` for Gemini, `marin`/`cedar` for OpenAI)
- **OpenAI Realtime support**: defaults to `gpt-realtime-2.1`; set `OPENAI_REALTIME_MODEL` to switch models (e.g. `gpt-live-1` once OpenAI makes GPT-Live available on the API). Requires `OPENAI_API_KEY`. Note: outbound announcements and the initial message of outbound conversations are still spoken with Google TTS, so `GOOGLE_API_KEY` remains required for outbound calls
- **Direct SIP trunk registration** - register with a carrier directly instead of (or in addition to) a local PBX:
  - TLS transport support (`SIP_TRANSPORT=tls`) for providers that only accept SIP over TLS on port 5061; a self-signed certificate is generated automatically
  - DNS SRV resolution with failover: registrar targets are looked up via SRV records (honoring priority and weight), cached until the TTL expires, and the next target is tried on errors or 503 responses
  - Custom DNS server support (`DNS_SERVER`) for providers whose SRV records only resolve through the local router's DNS
  - Split public/LAN addressing (`PUBLIC_IP` vs `EXTERNAL_IP`) for servers behind NAT
  - Compatibility fixes for strict carriers: provisional 180 Ringing before answering, explicit codec offers (G722, PCMA, PCMU), and E.164 numbers with a leading plus
- **Automatic public IP detection** for dynamic IP connections: set `PUBLIC_IP=auto` and the current public address is detected at startup and re-checked periodically (`PUBLIC_IP_CHECK_INTERVAL`, default 300s). On a change, all extensions re-register immediately with the new address and the FreeSWITCH advertised RTP address is refreshed via a Sofia profile restart (FreeSWITCH resolves it via STUN in auto mode). Calls that are active at the moment the ISP swaps the address still drop, since the old address stops existing; if audio stays broken afterwards, `docker compose restart` recovers everything
- **Native 24kHz audio** streamed back over the bidirectional audio fork with real-time pacing, instead of downsampled 8kHz file playback
- **Local voice activity barge-in**: interrupt the assistant mid-sentence without waiting for the server-side interruption signal
- **Configurable voice prompts** via `voice-app/config/prompts.json` (see [Voice Prompts](#voice-prompts))
- **Two conversation modes** with mid-call switching: *direct mode* (default, the voice provider answers natively for sub-second responses) and *relay mode* (an AI backend provides the answers and the voice provider speaks them)
- **Claude API bridge fallback**: calls work out of the box with the bundled claude-api-server when no OpenClaw route is configured

## Prerequisites

| Requirement | Where to Get It | Notes |
|-------------|-----------------|-------|
| **SIP provider** | [3cx.com](https://www.3cx.com/) or any SIP trunk | 3CX free tier works; direct trunk registration is also supported |
| **Google API Key** | [aistudio.google.com](https://aistudio.google.com/) | For Gemini Live speech and outbound call TTS |
| **OpenAI API Key** (optional) | [platform.openai.com](https://platform.openai.com/) | Only for `VOICE_PROVIDER=openai` (Realtime API) |
| **Claude Code CLI** | [claude.ai/code](https://claude.ai/code) | Requires Claude Max subscription |

## Platform Support

| Platform | Status |
|----------|--------|
| **macOS** | Fully supported |
| **Linux** | Fully supported (including Raspberry Pi) |
| **Windows** | Not supported (may work with WSL) |

## Quick Start

### 1. Install

```bash
curl -sSL https://raw.githubusercontent.com/theNetworkChuck/claude-phone/main/install.sh | bash
```

The installer will:
- Check for Node.js 18+, Docker, and git (offers to install if missing)
- Clone the repository to `~/.claude-phone-cli`
- Install dependencies
- Create the `claude-phone` command

### 2. Setup

```bash
claude-phone setup
```

The setup wizard asks what you're installing:

| Type | Use Case | What It Configures |
|------|----------|-------------------|
| **Voice Server** | Pi or dedicated voice box | Docker containers, connects to remote API server |
| **API Server** | Mac/Linux with Claude Code | Just the Claude API wrapper |
| **Both** | All-in-one single machine | Everything on one box |

### 3. Start

```bash
claude-phone start
```

## Deployment Modes

### All-in-One (Single Machine)

Best for: Mac or Linux server that's always on and has Claude Code installed.

```
┌─────────────────────────────────────────────────────────────┐
│  Your Phone                                                  │
│      │                                                       │
│      ↓ Call extension 9000                                  │
│  ┌─────────────┐                                            │
│  │     3CX     │  ← Cloud PBX                               │
│  └──────┬──────┘                                            │
│         │                                                    │
│         ↓                                                    │
│  ┌─────────────────────────────────────────────┐           │
│  │     Single Server (Mac/Linux)                │           │
│  │  ┌───────────┐    ┌───────────────────┐    │           │
│  │  │ voice-app │ ←→ │ claude-api-server │    │           │
│  │  │ (Docker)  │    │ (Claude Code CLI) │    │           │
│  │  └───────────┘    └───────────────────┘    │           │
│  └─────────────────────────────────────────────┘           │
└─────────────────────────────────────────────────────────────┘
```

**Setup:**
```bash
claude-phone setup    # Select "Both"
claude-phone start    # Launches Docker + API server
```

### Split Mode (Pi + API Server)

Best for: Dedicated Pi for voice services, Claude running on your main machine.

```
┌─────────────────────────────────────────────────────────────┐
│  Your Phone                                                  │
│      │                                                       │
│      ↓ Call extension 9000                                  │
│  ┌─────────────┐                                            │
│  │     3CX     │  ← Cloud PBX                               │
│  └──────┬──────┘                                            │
│         │                                                    │
│         ↓                                                    │
│  ┌─────────────┐         ┌─────────────────────┐           │
│  │ Raspberry Pi │   ←→   │ Mac/Linux with      │           │
│  │ (voice-app)  │  HTTP  │ Claude Code CLI     │           │
│  └─────────────┘         │ (claude-api-server) │           │
│                          └─────────────────────┘           │
└─────────────────────────────────────────────────────────────┘
```

**On your Pi (Voice Server):**
```bash
claude-phone setup    # Select "Voice Server", enter API server IP when prompted
claude-phone start    # Launches Docker containers
```

**On your Mac/Linux (API Server):**
```bash
claude-phone api-server    # Starts Claude API wrapper on port 3333
```

Note: On the API server machine, you don't need to run `claude-phone setup` first - the `api-server` command works standalone.

## CLI Commands

| Command | Description |
|---------|-------------|
| `claude-phone setup` | Interactive configuration wizard |
| `claude-phone start` | Start services based on installation type |
| `claude-phone stop` | Stop all services |
| `claude-phone status` | Show service status |
| `claude-phone doctor` | Health check for dependencies and services |
| `claude-phone api-server [--port N]` | Start API server standalone (default: 3333) |
| `claude-phone device add` | Add a new device/extension |
| `claude-phone device list` | List configured devices |
| `claude-phone device remove <name>` | Remove a device |
| `claude-phone logs [service]` | Tail logs (voice-app, drachtio, freeswitch) |
| `claude-phone config show` | Display configuration (secrets redacted) |
| `claude-phone config path` | Show config file location |
| `claude-phone config reset` | Reset configuration |
| `claude-phone backup` | Create configuration backup |
| `claude-phone restore` | Restore from backup |
| `claude-phone update` | Update Claude Phone |
| `claude-phone uninstall` | Complete removal |

## Device Personalities

Each SIP extension can have its own identity with a unique name, voice, and personality prompt:

```bash
claude-phone device add
```

Example devices:
- **Morpheus** (ext 9000) - General assistant
- **Cephanie** (ext 9002) - Storage monitoring bot

## API Endpoints

The voice-app exposes these endpoints on port 3000:

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/outbound-call` | Initiate an outbound call |
| GET | `/api/call/:callId` | Get call status |
| GET | `/api/calls` | List active calls |
| POST | `/api/query` | Query a device programmatically |
| GET | `/api/devices` | List configured devices |

See [Outbound API Reference](voice-app/README-OUTBOUND.md) for details.

## Troubleshooting

### Quick Diagnostics

```bash
claude-phone doctor    # Automated health checks
claude-phone status    # Service status
claude-phone logs      # View logs
```

### Common Issues

| Problem | Likely Cause | Solution |
|---------|--------------|----------|
| Calls connect but no audio | Wrong external IP | Re-run `claude-phone setup`, verify LAN IP |
| No audio when behind NAT | Public address not advertised | Set `PUBLIC_IP` in `.env` |
| Extension not registering | 3CX SBC not running | Check 3CX admin panel |
| Trunk registration rejected | Provider requires TLS | Set `SIP_TRANSPORT=tls` in `.env` |
| SRV lookup fails for trunk | Records only on router DNS | Set `DNS_SERVER` to your router's IP |
| "Sorry, something went wrong" | API server unreachable | Check `claude-phone status` |
| Port conflict on startup | Another SIP service on 5060/5061 | Set `DRACHTIO_SIP_PORT` / `DRACHTIO_TLS_PORT` |

See [Troubleshooting Guide](docs/TROUBLESHOOTING.md) for more.

## Configuration

Configuration is stored in `~/.claude-phone/config.json` with restricted permissions (chmod 600).

```bash
claude-phone config show    # View config (secrets redacted)
claude-phone config path    # Show file location
```

### SIP Trunk Registration

For registering directly with a SIP trunk provider instead of a local PBX, these `.env` variables matter (see `.env.example` for the full list):

| Variable | Default | Purpose |
|----------|---------|---------|
| `SIP_TRANSPORT` | `udp` | Set to `tls` for providers that only accept registration over TLS (port 5061) |
| `DNS_SERVER` | system DNS | DNS server for SRV lookups; set to your router's IP if the provider's SRV records only resolve through the local router's DNS |
| `PUBLIC_IP` | `EXTERNAL_IP` | Public address to advertise in SIP signaling and SDP when the server sits behind NAT |
| `DRACHTIO_SIP_PORT` | `5060` | SIP UDP/TCP listener port; change it if another SIP service uses 5060 |
| `DRACHTIO_TLS_PORT` | `5061` | SIP TLS listener port |

### Voice Prompts

The assistant's system prompts and greeting can be customized without touching code:

```bash
cp voice-app/config/prompts.json.example voice-app/config/prompts.json
```

| Key | Purpose |
|-----|---------|
| `directModeSystemPrompt` | System prompt when Gemini answers natively (default mode) |
| `relayModeSystemPrompt` | System prompt when Gemini only speaks responses from the AI backend |
| `greeting` | Instruction for the greeting spoken when a call connects |

`prompts.json` is gitignored, so personal or company-specific wording stays out of version control.

## Development

```bash
# Run tests
npm test

# Lint
npm run lint
npm run lint:fix
```

## Documentation

- [CLI Reference](cli/README.md) - Detailed CLI documentation
- [Troubleshooting](docs/TROUBLESHOOTING.md) - Common issues and solutions
- [Outbound API](voice-app/README-OUTBOUND.md) - Outbound calling API reference
- [Deployment](voice-app/DEPLOYMENT.md) - Production deployment guide
- [Claude Code Skill](docs/CLAUDE-CODE-SKILL.md) - Build a "call me" skill for Claude Code

## License

MIT
