# Image Resize Utility

This is a Node.js project for resizing images efficiently.

## Installation

Install dependencies using your preferred package manager. For example, using pnpm:

```bash
pnpm install
```

Alternatively, you can use npm or yarn:

```bash
npm install
# or
yarn install
```

## Usage

### Resize Images in a Folder

To resize all images in a folder, use:

```bash
pnpm run convert -- <source-folder> <destination-folder>
```

- `<source-folder>`: Path to the folder containing original images.
- `<destination-folder>`: Path where resized images will be saved.

Example:

```bash
pnpm run convert -- ./images/original ./images/resized
```

### Resize a Remote Image by URL

To resize a single image from a URL, use:

```bash
pnpm run convert-url -- <image-url> <output-file>
```

- `<image-url>`: URL of the image to resize.
- `<output-file>`: Path where the resized image will be saved.

Example:

```bash
pnpm run convert-url -- https://example.com/image.jpg ./images/resized/image.jpg
```

## Environment Variables

You can customize the resizing behavior by setting the following environment variables:

- `SIZE`: Target size (width or height) in pixels for the resized image (default: 1024).
- `PAD`: Whether to pad the image to a square (true/false, default: false).
- `VBIAS`: Vertical bias for padding alignment (0 to 1, default: 0.5).
- `QUALITY`: Quality setting for the output image (integer, default: 80).
- `AQUALITY`: Adaptive quality setting (integer, optional).
- `EFFORT`: Effort level for encoding (integer, default: 6).

Example of setting environment variables inline:

```bash
SIZE=800 PAD=true QUALITY=90 pnpm run convert -- ./images/original ./images/resized
```

## Typical Workflows

### Resize a Folder of Images

```bash
pnpm run convert -- ./photos ./photos_resized
```

### Process a Remote Image URL

```bash
pnpm run convert-url -- https://example.com/photo.jpg ./photos_resized/photo.jpg
```

Customize the output by setting environment variables as needed.
