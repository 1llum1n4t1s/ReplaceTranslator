# Privacy Policy — Replace Translator

Last updated: 2026-06-03

## Information we collect
Replace Translator does not collect, store, or transmit any personal information. It uses no analytics and no tracking.

## API keys
- Your API keys for each LLM provider (OpenAI / Anthropic / Google) are stored only inside your browser (`chrome.storage.local`).
- A key is sent only to its own provider's API for authentication when you translate. It is never sent to the extension's developer or any other third party.

## Page text
- When you click "Translate", the text on the page is sent only to the provider's API you selected, in order to receive the translation.
- How that text is handled is governed by each provider's privacy policy and terms:
  - OpenAI: https://openai.com/policies/
  - Anthropic: https://www.anthropic.com/legal
  - Google AI: https://ai.google.dev/gemini-api/terms
- No page text is ever sent to any server operated by the extension's developer (the only destination is the provider's API you chose).

## Token usage
- The token usage shown in the popup is stored only inside your browser (`chrome.storage.local`), per month. It is never transmitted anywhere.

## Why each permission is used
- `storage`: store settings, API keys, and token usage locally
- `scripting` / `activeTab` / `host_permissions`: inject the translator into the target page and talk to the provider API you selected
- `contextMenus`: translate / restore from the right-click menu

## Contact
GitHub Issues: https://github.com/1llum1n4t1s/ReplaceTranslator/issues
