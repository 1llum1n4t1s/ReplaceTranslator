# Privacy Policy — Replace AI Translator API

Last updated: 2026-08-27

## Information we collect
Replace AI Translator API's developer does not collect, store, or receive any of your data through the translation features, and the extension uses no analytics and no tracking. The text you translate — and, if you enable image translation, the images — are sent only to the translation provider you choose (see "Page text" and "Image translation" below).

The only exception is the contact form you submit yourself. Only then are the email address and message you typed sent to the developer's (Kagayoi) support desk (see "Contact form" below).

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
- `storage`: store settings, API keys, and token usage locally
- `scripting` / `activeTab` / `host_permissions`: inject the translator into the target page and talk to the provider API you selected
- `contextMenus`: right-click menu actions — translate page / translate selection / translate image / restore original

## Contact
GitHub Issues: https://github.com/1llum1n4t1s/ReplaceTranslator/issues
