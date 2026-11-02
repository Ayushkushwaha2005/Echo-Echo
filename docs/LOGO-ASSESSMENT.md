# Logo: technical assessment

This is a technical look at `brand/logo/echoecho-logo-original.jpeg`, dated 2 Nov 2026. **It is not a legal opinion and does not clear the logo.** No image was uploaded anywhere and no trademark register was searched.

## What the file shows about where it came from

| Check | Result |
|---|---|
| SHA-256 | `3bc55edaacc877a03d0ca27014a4be6113a87073cb63183f1a6545d7133b04ea` |
| Format | Progressive JPEG, 1254 × 1254, RGB |
| EXIF, XMP, C2PA or a tool name | None. The file carries no creator, software or date |
| First in this repository | `fe89fed`, 14 Oct 2026, from a file the owner supplied (`Downloads/6.jpeg`) |
| Layered source file | None in this repository |

**So the file does not record who made it or how, and the rights in it can't be shown from the file.** The soft rendering and missing source files could fit an image generator, but that is only a guess. The owner needs to record how it was made.

## What it looks like

Compared by eye with the public character, because no reference image was downloaded:

- **The symbol:** the green and black hourglass in a circle appears four times: on the apron, on the cup, on the right forearm area and inside the final O of ECHO. It closely resembles the Omnitrix symbol from the *Ben 10* franchise.
- **The character:** a small white robot-like figure with a seamed head, large round ear pieces, and green slit eyes and mouth. This closely resembles the *Ben 10* alien that is itself called Echo Echo.
- **The name:** ECHO ECHO is that character's name. A name shared with a character is a narrower question than the artwork, and it is the one a trademark search would answer.
- **The colours:** the green, black and white palette reinforces the same association.

The food items, chef's hat, lettering and the line "Good Food, Better Vibes" do not add to this concern.

## Engineering view

Treat this as a real risk: the resemblance is specific and repeated, and it's on a commercial food service. It reaches every surface, because the derived files in `brand/logo/` are the favicon, the app icons, the sharing image and the header logo.

Replacing it is cheap: `tools/logo-assets.py` regenerates every size from one source file, so a new logo needs no code changes.

## What the owner has to do

1. Have a new logo drawn without the hourglass symbol or that character, and keep the source files and the agreement or licence.
2. Ask a trademark lawyer about the name ECHO ECHO in the classes that cover food delivery and software, including a search of the Indian register.
3. Put the new file at `brand/logo/echoecho-logo-original.jpeg` and run `python tools/logo-assets.py`.
