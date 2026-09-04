# Privacy Policy — Replace AI Translator API

Last updated: 2026-09-05

## Information we collect
Replace AI Translator API's developer does not collect, store, or receive any of your data through the translation features, and the extension uses no analytics and no tracking. The text you translate — and, if you enable image translation, the images — are sent only to the translation provider you choose (see "Page text" and "Image translation" below).

The only exception is the contact form you submit yourself. Only then are the email address and message you typed sent to the developer's (Kagayoi) support desk (see "Contact form" below).

## API keys
- Your API keys for each LLM provider (OpenAI / Anthropic / Google / xAI) are stored only inside your browser (`chrome.storage.local`). MyMemory needs no key.
- A key is sent only to its own provider's API for authentication when you translate. It is never sent to the extension's developer or any other third party.

## Auto-translate exclusions
- URL, host, and wildcard rules you add are stored inside your browser (`chrome.storage.local`). When you enable "Sync settings across PCs", they are also stored using browser sync as described below.
- These rules are used only to decide on-device whether to auto-translate the current page. They are never sent to the developer or a translation provider.

## Settings sync (optional)
- Each setting carries its edit timestamp, logical counter, and a randomly generated device ID to resolve conflicts. Exclusion-rule and reasoning-preference deletion records are retained to prevent older devices from restoring removed entries. The device ID is generated within this extension; it does not use your PC name or hardware identifiers.
- "Sync settings across PCs" is off by default. Only when you enable it on each PC, languages, translation service, models, reasoning effort, display preferences, auto-translate, and exclusion rules are stored in `chrome.storage.sync` and shared through the browser provider's sync service across PCs using the same account. They do not pass through the developer's servers.
- API keys, source text, translations, caches, usage counts, and your persistent-cache preference are not synced.
- Turning it off stops sync reads and writes on that device and keeps the current local and synced settings. Synced data is handled under your browser provider's privacy policy.

## Page text
- When you click "Translate", the text on the page is sent only to the provider's API you selected, in order to receive the translation.
- To reduce repeated API requests for identical text, the extension caches source text, nearby context, and translations on-device for the browser session. The same cache is stored on-device for up to 30 days (up to 2,000 entries) only when you explicitly enable "Persistent translation cache". Turning it off deletes the saved cache. This cache is never sent to the developer's servers.
- How that text is handled is governed by each provider's privacy policy and terms:
  - OpenAI: https://openai.com/policies/
  - Anthropic: https://www.anthropic.com/legal
  - Google AI: https://ai.google.dev/gemini-api/terms
  - xAI (Grok): https://x.ai/legal/privacy-policy
  - MyMemory (Translated): https://mymemory.translated.net/doc/en/tos.php
- No page text is ever sent to any server operated by the extension's developer (the only destination is the provider's API you chose). The only thing that reaches the developer's server is what you type into the contact form yourself.

## Image translation (optional)
- Image translation runs only when you explicitly act on an image (clicking the button shown on the image, or choosing "Translate this image" in the right-click menu). That single image is fetched and sent as image data to the vision-capable provider you selected, in order to read and translate the text inside the image. Images on the page are never sent automatically or in bulk.
- This is governed by the same provider privacy policies and terms listed above. MyMemory does not support image translation.

## Token usage
- Token usage counts are stored only inside your browser (`chrome.storage.local`), per month. They are never transmitted anywhere.

## Contact form
- Only when you press "Contact support" in the settings popup and submit the form does the extension send the email address, optional name, inquiry category, subject, and message you entered — along with the product ID, extension version, and locale — to Kagayoi Support (`https://support.kagayoi.com`). No such request happens unless you press the button.
- On first use, the six-digit code delivered by email is sent to Kagayoi Support to verify you. After verification, Kagayoi Support stores the inquiry and replies so that you and support staff can access them.
- Page text, images, API keys, and token usage are never sent.

## Why each permission is used
- `storage`: store settings (including auto-translate exclusions), API keys, token usage, and the translation cache on-device, and sync settings when you enable this option
- `alarms`: retry incomplete settings sync; cleared when sync is turned off
- `scripting` / `activeTab` / `host_permissions`: inject the translator into the target page and talk to the provider API you selected
- `contextMenus`: right-click menu actions — translate page / translate selection / translate image / restore original / add or remove an auto-translate exclusion

## Contact
GitHub Issues: https://github.com/1llum1n4t1s/ReplaceTranslator/issues
