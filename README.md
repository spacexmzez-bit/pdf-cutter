# PDF Cutter

A browser-based PDF utility for extracting selected pages and inserting marker pages. PDF files are processed locally in the browser; there is no application backend and no PDF upload endpoint.

## Features

- **PDF compressor:** lossless structural optimization or balanced/maximum embedded-image compression, with before/after size, a page preview, and a no-growth safeguard. Uses the qpdf WebAssembly engine locally, without rasterizing whole pages.
- **PDF cutter:** keep individual pages, ranges, or multiple ranges such as 1-37, 88-119.
- **Multiple Cuts:** split one PDF into up to 50 named PDF pieces, each with its own page ranges. Pieces may overlap, so shared cover pages can appear in multiple outputs. Preview one piece at a time, download pieces individually, or package all of them into a ZIP.
- **JSON piece import:** import a JSON file or pasted JSON array using exactly two fields per piece: `part_name` and `pages_range`. The Copy JSON format button copies a blank reusable structure.
- **Preview before creating:** inspect the selected page sequence before downloading the result.
- **PDF marker:** insert a marker before or after each selected original page while keeping all original pages.
- **Custom marker page:** optionally upload a PDF and use its first page as the inserted marker. Without a custom file, a blank page matching the nearby page size is inserted.
- **Local project history:** remember recent source PDFs, settings, and generated results in this browser using IndexedDB. History can be disabled or cleared at any time.
- **Installable web app (PWA):** install PDF Cutter from supported browser menus or the site's Install app control. The app shell and bundled PDF engine are cached for offline use after a successful first load.
- **Responsive interface:** works on desktop and mobile browsers.

## Compression design

The compressor runs **qpdf WebAssembly** in a dedicated browser worker. Lossless mode rewrites the PDF structure without changing image pixels. Balanced and Maximum additionally re-encode compatible embedded RGB/grayscale images as JPEG, with optional downsampling. Text, links, and other PDF objects are not flattened into page images.

**Limits:** Not every PDF becomes smaller. If the optimized result is not smaller, the original bytes are kept. Unsupported, masked, ICC/CMYK, JPEG2000, JBIG2, and complex image encodings are left untouched. Very large or complex PDFs can exceed browser memory; the compressor limits input files to 256 MB. Rewriting a digitally signed PDF can invalidate signatures. Always inspect the preview before downloading, and retain the original document. PDF metadata and complex interactive features should be verified on important documents.

The image stream engine is [@lipoe/browser-qpdf](https://github.com/lipoe/browser-qpdf) v0.3.1 (Apache-2.0), based on qpdf 12.4.2. Redistribution notices are included under `public/licenses/`. The rest of PDF Cutter remains MIT-licensed.

## Run locally

1. Install Node.js 20 or newer.
2. Install project dependencies with npm install.
3. Run tests with npm test.
4. Start the development server with npm run dev.
4. Open the local address printed by Vite.

Create a production build with npm run build. The generated static site is placed in dist.

## GitHub Pages

The included GitHub Actions workflow builds the site and deploys dist to GitHub Pages whenever a commit is pushed to main. In the repository settings, set Pages → Build and deployment → Source to **GitHub Actions**.

## Install as a web app

Open the GitHub Pages website over HTTPS. On Chrome or Edge, select **Install app** in the site header or browser menu. On iPhone/iPad in Safari, choose **Share → Add to Home Screen**. Browser installation support varies.

The production build generates a versioned service worker that caches the static app shell, icons, PDF.js worker, and scripts so the app can run offline after it has loaded successfully. This is separate from IndexedDB project history: the service worker never caches user PDF documents. Existing locally saved projects remain subject to browser storage availability.

## Privacy and storage

- PDF parsing, page rendering, page copying, and PDF generation run in the user's browser.
- The application does not send PDF contents to an application server or third-party PDF processing service.
- The production JavaScript bundles PDF.js, pdf-lib, and fflate locally. Internet access is needed for the initial hosted load. After the app assets have been cached, the installed app can also work offline. Documents are never sent to a processing service.
- When **Remember recent projects** is enabled, the browser stores the original PDF, optional marker template, generated output(s), and project settings in IndexedDB. This storage belongs to the current browser profile and may be cleared by browser settings, private browsing, or storage cleanup.
- Turn off the history toggle to stop saving new projects. Use **Clear local history** to delete saved projects and PDFs from this browser.
- Anyone who can use the same unlocked browser profile may be able to access its saved local history. Do not enable local history on a shared or untrusted device.

## Important limitations

- A custom marker PDF contributes its first page only.
- Very large PDFs may require substantial browser memory. The preview renders the first 60 pages of the currently selected output piece; generated PDFs still contain every selected page. Multiple Cuts supports up to 50 pieces per operation.
- Editing a digitally signed PDF may invalidate its signature. Review generated documents before relying on them.
- Complex PDF features such as interactive forms, document-level bookmarks, and some annotations may not be preserved by page copying. Keep an untouched original when those features matter.

## Technology

Vite, PDF.js, pdf-lib, qpdf WebAssembly, Web Workers, and IndexedDB. All document operations are client-side.

## License

MIT. See LICENSE.
