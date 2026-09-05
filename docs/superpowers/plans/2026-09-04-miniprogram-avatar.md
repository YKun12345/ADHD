# Mini Program Avatar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate and deliver one production-ready 1024 × 1024 PNG avatar that clearly connects the mini program to ADHD cognitive assessment and its “星仔” assistant.

**Architecture:** Use the built-in image generation tool to create one flat, vector-like bitmap from the approved specification. Inspect the result against the visual constraints, then copy the accepted image into a dedicated project branding directory without changing application code.

**Tech Stack:** Built-in image generation tool, PNG, PowerShell file inspection, built-in image viewer

---

### Task 1: Generate the approved avatar

**Files:**
- Reference: `docs/superpowers/specs/2026-09-04-miniprogram-avatar-design.md`
- Create at generation time: built-in generated-image artifact

- [ ] **Step 1: Generate one square avatar with the approved prompt**

Use the built-in image generation tool in `logo-brand` mode with this exact prompt:

```text
Use case: logo-brand
Asset type: WeChat mini program avatar, final raster PNG
Primary request: Create a premium minimalist app icon for an ADHD cognitive assessment and health-management mini program. The icon must clearly show a simplified, symmetrical human brain silhouette. Cut one clearly visible four-point star out of the exact center of the brain as negative space; the star represents the AI health assistant “星仔” and positive growth.
Scene/backdrop: Full-bleed solid deep teal-navy background #173F50.
Subject: One centered pearl-white brain symbol #F7FAF8 with a central four-point star-shaped negative-space cutout.
Style/medium: Flat vector-like brand mark rendered as a clean 1024 × 1024 bitmap; mature digital-health identity; geometric, calm, warm, premium.
Composition/framing: Perfectly centered and balanced; generous safe margin; rounded outer canvas composition that remains safe under WeChat rounded-square or circular cropping; readable at 28 × 28 pixels.
Color palette: Exactly two colors, #173F50 and #F7FAF8.
Constraints: no text; no letters; no extra symbols; no internal brain folds except the central negative-space star; smooth rounded brain contour; strong silhouette; crisp edges.
Avoid: gradients, shadows, highlights, 3D, glass, metallic effects, texture, border, watermark, medical cross, ECG line, pills, stethoscope, people, face, cartoon expression, extra stars, dots, rings, orbit lines, decorative details.
```

Expected result: one square icon with only a deep teal-navy background and a pearl-white brain/negative-star mark.

- [ ] **Step 2: Inspect the generated image at full size**

Open the generated image with the built-in image viewer at original detail.

Expected result:

- The brain is recognizable without explanatory text.
- The four-point negative-space star is centered and clearly visible.
- No prohibited text, medical symbols, shading, gradient, texture, or decoration appears.
- The background and mark visually match `#173F50` and `#F7FAF8`.

- [ ] **Step 3: Regenerate once only if a concrete acceptance check fails**

Repeat the same prompt with one targeted correction naming the failed condition. Preserve all other approved constraints.

Expected result: the corrected image passes every check from Step 2.

### Task 2: Save and verify the project asset

**Files:**
- Create: `miniprogram/assets/branding/adhd-mind-star-avatar.png`
- Do not modify: existing mini program configuration or page files

- [ ] **Step 1: Create the branding directory**

Run:

```powershell
New-Item -ItemType Directory -Force -Path 'miniprogram\assets\branding'
```

Expected result: `miniprogram/assets/branding/` exists and no existing file is overwritten.

- [ ] **Step 2: Copy the accepted generated artifact into the project**

Copy the image returned by the built-in generator to:

```text
miniprogram/assets/branding/adhd-mind-star-avatar.png
```

Expected result: the destination file exists as a PNG.

- [ ] **Step 3: Verify dimensions and format**

Run:

```powershell
Add-Type -AssemblyName System.Drawing
$avatarImage = [System.Drawing.Image]::FromFile((Resolve-Path 'miniprogram\assets\branding\adhd-mind-star-avatar.png'))
"$($avatarImage.Width)x$($avatarImage.Height) $($avatarImage.RawFormat)"
$avatarImage.Dispose()
```

Expected output begins with:

```text
1024x1024
```

- [ ] **Step 4: Perform final visual verification**

Open `miniprogram/assets/branding/adhd-mind-star-avatar.png` with the built-in image viewer.

Expected result: the saved project asset matches the accepted generated image, remains legible when shown as a thumbnail, and contains no text or watermark.

- [ ] **Step 5: Check repository scope**

Run:

```powershell
git status --short
```

Expected result: the new avatar and this plan are visible; pre-existing untracked screenshots remain untouched; no mini program source or configuration file changed.
