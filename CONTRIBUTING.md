# Contributing to PDF Editor

Thanks for helping! Every kind of contribution is welcome: bug reports, ideas, translations, docs, design and code.

New here? Look for issues labelled [`good first issue`](https://github.com/krishnakantnagina/pdf-editor-app/labels/good%20first%20issue) or [`help wanted`](https://github.com/krishnakantnagina/pdf-editor-app/labels/help%20wanted).

## Ground rules

- **Privacy first.** PDFs must never leave the user's device. No analytics, trackers, CDNs or network calls for user files.
- **No build step for the web app.** It's plain HTML, CSS and JavaScript (ES modules). Please don't add a bundler or framework.
- **Mobile first.** Check every UI change at phone width (about 390 px) as well as on desktop.
- Be kind. This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Run the web app

```bash
git clone https://github.com/krishnakantnagina/pdf-editor-app.git
cd pdf-editor-app
npx serve .          # or: python -m http.server 8000
```

Open the URL it prints. Browsers block ES modules on `file://`, so you do need a local server.

## Build the Android APK

You need Node.js 20+, JDK 21 and the Android SDK (Android Studio installs it).

```bash
npm install
npm run android:sync   # copies the web app into android/
npm run android:open   # opens Android Studio, then press Run
# or, from the command line:
npm run android:build  # APK in android/app/build/outputs/apk/debug/
```

Every pull request builds a debug APK automatically. You can download it from the **Actions** tab, under the run's **Artifacts**.

## Project layout

| Path | What it does |
| --- | --- |
| `index.html` | App shell |
| `css/style.css` | Styles (mobile first) |
| `js/app.js` | UI, state, tools, undo/redo, native (Android) save/share |
| `js/annots.js` | Annotation model: geometry, drawing, rotation maths |
| `js/core.js` | pdf.js setup and page rendering |
| `js/exporter.js` | Writes the final PDF with pdf-lib; compress; images to PDF |
| `js/zip.js` | Tiny ZIP writer |
| `sw.js` | Service worker (offline cache for the web version) |
| `android/` | Capacitor Android project |
| `lib/` | Vendored pdf.js and pdf-lib. Don't edit these by hand |

## Making a change

1. Fork the repo and create a branch: `git checkout -b fix/short-description`.
2. Make your change. Keep pull requests small and focused on one thing.
3. Test it by hand in the browser:
   - open a PDF, make the change you worked on, **save**, and open the saved file in another PDF reader;
   - check that the browser console shows no errors;
   - if you touched page rendering or export, also try a rotated page.
4. Commit with a clear message, e.g. `Fix stamp position on rotated pages`.
5. Open a pull request and fill in the template. Add screenshots for UI changes.

When a release bumps `version` in `package.json`, update `APP_VERSION` at the top of `js/app.js` too, so the About sheet shows the right number.

If you add a file that the app loads, also add it to the `CORE` list in `sw.js` and bump `VERSION` there, so the offline cache picks it up.

## Reporting bugs

Use the [bug report form](https://github.com/krishnakantnagina/pdf-editor-app/issues/new?template=bug_report.yml). If you can, attach a PDF that shows the problem. **Never attach a PDF that contains personal or private information.**

## Security issues

Please don't open public issues for security problems. See [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
