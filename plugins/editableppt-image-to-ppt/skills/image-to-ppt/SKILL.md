---
name: image-to-ppt
description: Convert one or more local PNG/JPG images into one editable PowerPoint presentation with the EditablePPT MCP tool. Use when the user asks to turn images or screenshots into an editable PPTX.
---

# Image to PPT

Use the `editableppt-image-to-ppt` MCP tool `convert_images_to_pptx` with absolute local image paths in the requested slide order. The tool accepts 1-20 PNG/JPG files (8 MB each) and returns a job ID. Query `get_conversion_status` with that ID until it reports `success` and an `output_path`, or `failed` with an error. It uses EditablePPT's AI layer conversion, so each image becomes an editable slide. Conversion may take several minutes; do not start a duplicate call while one is running.

On first use, if the tool reports missing authorization, open `https://editableppt.com/settings/apikeys` for the user. Ask them to sign in and create an API key named `Codex MCP`. Then run `node ../../server.mjs auth` from this skill's directory in an interactive terminal so they can paste the key there. Never ask them to paste the key in chat or put it in a repository file. The command validates the key and saves it at `~/.config/editableppt/mcp-auth.json` with owner-only permissions. After authorization, call the MCP tool again.

If the MCP tool is unavailable, install this plugin from the repository marketplace with `codex plugin marketplace add <repo-root>` and `codex plugin add editableppt-image-to-ppt@editableppt`, then start a new Codex task to load it. The repository marketplace is `.agents/plugins/marketplace.json`. Never claim conversion succeeded until `get_conversion_status` returns `success` and an existing `.pptx` path.
