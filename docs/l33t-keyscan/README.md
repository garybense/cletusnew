![banner](./banner.png)

A reasonably thorough secret scanner and live API key validator/tester. Finds exposed API keys and sensitive credentials lurking in your files, then tests supported keys live against their service endpoints to see which ones are still active.

## What It Does

**l33t-APIKeyScanr** is a security auditing tool designed for personal and organizational security scanning:

- 🔍 **Recursive parallel file scanning** — Multithreaded scanning recursively searches directories for exposed secrets.
- 🚫 **Binary file skipping** — Safely detects and skips binary files (images, archives, compiled binaries, databases) using file extension and byte-level heuristics.
- 📐 **Structured Python rule system** — Broad detection coverage across 100+ providers and secret categories using compiled Python data structures.
- 🧮 **Shannon entropy filtering** — Calculates entropy on candidate secrets to filter out low-entropy false positives.
- ✅ **Live key validation** — Tests supported key types live against service endpoints to determine if they are active.
- 🔑 **All auth styles** — Detects Bearer tokens, custom headers, Basic auth, query parameters, and body credentials.
- 📊 **Historical tracking** — Saves timestamped results to `key_test_results.json` for auditing and comparison across scans.
- ⚡ **Configurable targets** — Target specific paths/files or scan smart defaults (home directory, `.env`, `.bashrc`, `.npmrc`, etc.).

## Detection Coverage & Live Validation

### Secret Categories Detected
- **API Keys & Provider Tokens** (OpenAI, Anthropic, xAI, Google/GCP, AWS, Azure, Stripe, GitHub, GitLab, Slack, Twilio, SendGrid, Hugging Face, Groq, Mistral, Pinecone, Supabase, Clerk, Vercel, Cloudflare, etc.)
- **Private Keys & Certificate Material** (SSH, RSA, DSA, EC, OpenSSH, encrypted PEM keys)
- **Authentication Tokens** (JWTs, OAuth client secrets, access/refresh tokens)
- **Database Connection Strings** (PostgreSQL, MySQL, MongoDB, Redis URIs and passwords)
- **Webhook Signing Secrets & Specialized Vendor Credentials**

*Note:* Detection coverage and live validation are separate. The scanner detects secrets across dozens of providers, but live API validation is performed only for supported API key providers (OpenAI, Anthropic, Google, NVIDIA, OpenRouter, DeepSeek, ElevenLabs, Groq, Together, Perplexity, Fireworks, Replicate). Newly detected providers without live test endpoints are marked as detected and `skipped` during live validation without network calls.

## Installation

### Requirements
- Python 3.7+
- `requests` library

### Setup

```bash
# Clone the repository
git clone https://github.com/garybense/l33t-APIKeyScanr.git
cd l33t-APIKeyScanr

# Install dependencies
pip install requests

# Make it executable
chmod +x l33t_APIKeyScanr.py
```

## Usage

### Basic Scan (Home Directory)

```bash
./l33t_APIKeyScanr.py
```

Scans your home directory, home config files, and common locations (`.env`, `.bashrc`, `.npmrc`, etc.) for exposed keys.

### Scan Specific Path

```bash
./l33t_APIKeyScanr.py --path /path/to/project
```

### Scan Specific Files

```bash
./l33t_APIKeyScanr.py --file ~/.bashrc ~/.env src/config.py
```

### Include Library Directories

By default, library directories (`node_modules`, `site-packages`, `.venv`) are skipped. To include them:

```bash
./l33t_APIKeyScanr.py --include-libraries
```

### Set Max File Size

Skip large files (reduces noise from large files):

```bash
./l33t_APIKeyScanr.py --max-size 5242880  # 5 MB in bytes
```

### JSON Output

Output results as JSON instead of formatted terminal output:

```bash
./l33t_APIKeyScanr.py --json
```

### Show Previous Results

View historical scan results from `key_test_results.json`:

```bash
./l33t_APIKeyScanr.py --testresults
./l33t_APIKeyScanr.py --testresults --testresults-file /path/to/results.json
```

### Running Tests

Run the unit test suite:

```bash
python3 -m unittest discover -s tests
```

## Results

Scan results are saved to `key_test_results.json` in the script directory. Each entry includes:

```json
{
  "key": "sk-proj-...",
  "type": "OpenAI API Key",
  "filepath": "/path/to/file",
  "line": 42,
  "status": "success",
  "provider": "openai",
  "elapsed": 0.234
}
```

Use `--testresults` to review historical scans and track active credentials.

## Security Considerations

⚠️ **Handles sensitive credential data.**
Results contain plaintext secret information. Secure output files appropriately.

## License & Attribution

MIT License — See LICENSE for project licensing.

This product includes detection pattern coverage derived from Poltergeist (https://github.com/ghostsecurity/poltergeist), licensed under the Apache License, Version 2.0. See the `NOTICE` file for attribution details.
