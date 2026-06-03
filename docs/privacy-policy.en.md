# Privacy Policy — Replace Translator

Last updated: 2026-06-03

## Information we collect
Replace Translator does not collect, store, or transmit any personal information. It uses no analytics and no tracking.

## API keys
- Your API keys for each LLM provider (OpenAI / Anthropic / Google / xAI) are stored only inside your browser (`chrome.storage.local`). MyMemory needs no key.
- A key is sent only to its own provider's API for authentication when you translate. It is never sent to the extension's developer or any other third party.

## Page text
- When you click "Translate", the text on the page is sent only to the provider's API you selected, in order to receive the translation.
- How that text is handled is governed by each provider's privacy policy and terms:
  - OpenAI: https://openai.com/policies/
  - Anthropic: https://www.anthropic.com/legal
  - Google AI: https://ai.google.dev/gemini-api/terms
  - xAI (Grok): https://x.ai/legal/privacy-policy
  - MyMemory (Translated): https://mymemory.translated.net/doc/en/tos.php
- No page text is ever sent to any server operated by the extension's developer (the only destination is the provider's API you chose).

## Image translation (optional)
- When image translation is enabled, the image you select (or images on the page) are fetched and sent as image data to the vision-capable provider you selected, in order to read and translate the text inside the image.
- This is governed by the same provider privacy policies and terms listed above. MyMemory does not support image translation. The feature is off by default.

## Token usage
- Token usage counts are stored only inside your browser (`chrome.storage.local`), per month. They are never transmitted anywhere.

## Why each permission is used
- `storage`: store settings, API keys, and token usage locally
- `scripting` / `activeTab` / `host_permissions`: inject the translator into the target page and talk to the provider API you selected
- `contextMenus`: translate / restore from the right-click menu

## Contact
GitHub Issues: https://github.com/1llum1n4t1s/ReplaceTranslator/issues
