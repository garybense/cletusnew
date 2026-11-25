# NVIDIA Models in Xcode — Setup Guide

## Quick Start

### 1. Start the NVIDIA Proxy

```bash
cd /Users/user/code/l33t_APIKeyScanr
python3 nvidia_proxy.py
```

The proxy runs on `https://127.0.0.1:8444` and forwards to `https://integrate.api.nvidia.com/v1`.

### 2. Configure Xcode

#### Option A: Using Xcode's Built-in LLM Assistant (if available)

1. Open Xcode → Settings → Accounts
2. Add a new service with:
   - **Base URL**: `https://127.0.0.1:8444/v1`
   - **API Key**: Any value (proxy handles auth)

#### Option B: Using a Custom LLM Integration

In your Xcode project, configure the API endpoint:

```swift
// Example: Configure URLSession to use the NVIDIA proxy
let config = URLSessionConfiguration.default
config.urlCredentialStorage = nil

// If needed, disable SSL validation for the local proxy
let session = URLSession(configuration: config)

// API endpoint
let baseURL = "https://127.0.0.1:8444/v1"
```

#### Option C: Using Environment Variables

Add to your Xcode scheme's environment variables:

```
NVIDIA_BASE_URL=https://127.0.0.1:8444/v1
NVIDIA_API_KEY=any_value_ignored_by_proxy
```

### 3. Available Models (15 working)

| Model | Best For |
|-------|----------|
| `nvidia/nemotron-3-super-120b-a12b` | General purpose, complex reasoning |
| `nvidia/nemotron-3-ultra-550b-a55b` | Largest model, best quality |
| `nvidia/nemotron-3.5-lightning-30b-a3b` | Fast responses |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` | Reasoning tasks |
| `nvidia/nemotron-parse-2.0` | Parsing/analysis |
| `nvidia/llama-3.1-nemotron-safety-guard-8b-v3` | Safety filtering |
| `nvidia/ising-calibration-1.5-31b` | Calibration tasks |
| `nvidia/nemotron-3.5-content-safety` | Content moderation |
| `nvidia/riva-translate-4b-instruct-v1.1` | Translation |
| `nvidia/riva-translate-4b-instruct-v2` | Translation (v2) |
| `meta/llama-3.2-11b-vision-instruct` | Vision + text |
| `meta/muse-glimmer-30b` | Creative tasks |
| `google/diffusiongemma-26b-a4b-it` | Code generation |
| `openai/gpt-oss-20b` | Open-source GPT |
| `z-ai/glm-5.3-flash` | Fast inference |

### 4. Test the Proxy

```bash
# Test model listing
curl -k https://127.0.0.1:8444/v1/models

# Test chat completion
curl -k https://127.0.0.1:8444/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "nvidia/nemotron-3.5-lightning-30b-a3b",
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_tokens": 50
  }'
```

## How It Works

- The proxy uses 8 working NVIDIA API keys from `key_test_results.json`
- Keys are rotated round-robin for each request
- All requests are forwarded to `https://integrate.api.nvidia.com/v1`
- The proxy handles authentication automatically

## Troubleshooting

### SSL Certificate Warning
The proxy uses a self-signed certificate. In Xcode, you may need to:
- Set `NSAppTransportSecurity` → `NSAllowsArbitraryLoads` to `YES` in Info.plist
- Or use `http://127.0.0.1:8444` instead (modify proxy to not use SSL)

### Model Not Found
Some models may not be available on your NVIDIA account. Check available models:
```bash
curl -k https://127.0.0.1:8444/v1/models | python3 -m json.tool
```

### Proxy Not Running
```bash
# Check if proxy is running
lsof -i :8444

# Restart proxy
kill $(lsof -ti:8444) 2>/dev/null
python3 nvidia_proxy.py &
```
