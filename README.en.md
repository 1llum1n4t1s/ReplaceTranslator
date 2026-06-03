# 📖 Replace Translator

> 日本語版は [README.md](README.md) を参照してください。

A Chrome / Firefox extension that translates the page you are viewing **in place** using cloud LLMs (OpenAI / Anthropic / Google Gemini). Like Chrome's built-in page translation, it replaces the original text with the translation and lets you switch back with one click — but it uses large language models for more natural, context-aware results.

## ✨ Features
- **In-place replacement** — replace the original text with the translation, toggle back to the original
- **Multiple LLM providers** — switch between OpenAI / Anthropic (Claude) / Google Gemini / xAI (Grok) using your own API key
- **No-key option** — MyMemory (free NMT) works with no key or signup (best for short text, instant trial)
- **Pinpoint mixed-language translation** — text already in the target language is left untouched; only the other languages are translated
- **Infinite scroll friendly** — content loaded later is translated automatically
- **Image text translation (experimental)** — hover an image and click 訳 to translate the text inside it and overlay the result (vision-capable LLMs)
- **Multilingual** — pick the source (auto-detect available) and target language freely
- **Token usage display** — current-month token usage per provider (auto-resets each month, persists across browser restarts)
- **Privacy-first** — API keys stay local in your browser; text is sent only to the provider you chose

## 🔑 About API keys
In line with each provider's terms, this extension works with **API keys (API tokens) only**. Reusing a subscription login (ChatGPT Plus / Claude Pro / Gemini Advanced, etc.) is against those providers' terms of service, so it is not supported.

Get an API key here:

| Provider | Where | Notes |
|---|---|---|
| Google Gemini | https://aistudio.google.com/app/apikey | **Free tier available**, no card required to try |
| OpenAI | https://platform.openai.com/api-keys | Pay as you go |
| Anthropic (Claude) | https://console.anthropic.com/settings/keys | Pay as you go |
| xAI (Grok) | https://console.x.ai/ | Pay as you go (OpenAI-compatible API) |
| MyMemory | **No key** | Free NMT, no signup, instant trial (short text, 5k–50k chars/day, no mixed-language translation) |

> To try it for free, **Google Gemini** (free tier) is recommended.

## 📥 Install

### Load the development build (current method)
1. Download / clone this repository
2. Open `chrome://extensions` in Chrome and turn on "Developer mode"
3. Click "Load unpacked" and select this folder

Store links (Chrome Web Store / Firefox Add-ons) will be added once published.

## 🚀 Usage
1. Open the toolbar icon and enter your API key in the **"Keys" tab** (MyMemory needs no key)
2. In the **"Translate" tab**, pick a service and target language, then "Translate". Use "Restore" to go back
3. You can also toggle translate/restore with the **floating button (文 → 訳) at the bottom-right of the page** (drag it anywhere you like)
4. The right-click menu also offers "Translate this page" / "Restore original"
5. Turn on **image text translation** in the "Keys" tab, then hover an image and click 訳 to translate text inside it (experimental, vision-capable LLMs)

### Source / target
- **Source** — leave it on "Detect language" and only text that differs from the target gets translated (great for mixed-language pages). You can also pin a specific source language.
- **Target** — pick the language you want.

## 📊 Token usage
The popup shows current-month token usage per provider and a total. It restarts from zero when the month changes (past months are kept locally).

## 🌐 Supported languages
Japanese, English, Chinese (Simplified / Traditional), Korean, Spanish, French, German, Portuguese, Russian, Italian and other major languages.

## 🔒 Privacy
- API keys and token usage are stored **only inside your browser**
- Page text is sent **only to the provider API you selected** when translating (never to the extension developer's servers)
- See the [Privacy Policy](docs/privacy-policy.en.md) for details

## 🛠 Troubleshooting
- **"No API key set"** — enter the key for the selected provider in Settings (⚙)
- **Nothing happens / errors** — check the key is correct and that you have not exceeded your balance / rate limit
- **Only part of the page is translated** — text already in the target language is intentionally left as is
- If something is off, reload the extension (the 🔄 on `chrome://extensions`) and try again

## 📄 License
[MIT License](LICENSE)

## 👩‍💻 For developers
See [CONTRIBUTING.md](CONTRIBUTING.md) and [CLAUDE.md](CLAUDE.md) for build, test, and architecture.
