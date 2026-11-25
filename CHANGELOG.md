# Changelog

All notable changes to this project are listed here. This project follows [Semantic Versioning](https://semver.org).

## [Unreleased]

### Added
- The About sheet (Menu → About) now shows the app version, so bug reports can say which version they came from.

## [1.0.0] - 2026-11-25

First public release.

### Added
- Android app (APK), built with Capacitor. Files are saved to `Documents/PDF Editor` or shared through the Android share sheet.
- Android back button closes dialogs and steps back through the app.
- Edit and sign: text, freehand drawing, highlight, shapes, signatures (draw or type), images, stamps, whiteout and secure redaction.
- Fill PDF forms, with optional flattening.
- Organise pages: merge, split, extract, reorder, rotate, duplicate, delete, insert blank pages.
- Convert: images to PDF, PDF to JPG/PNG, extract text.
- Compress, watermark, page numbers, unlock password-protected PDFs, edit document details.
- Undo/redo, keyboard shortcuts, drag and drop, installable offline web app (PWA).

### Fixed
- The Pages view no longer crashes when "Open" is tapped after every page was deleted.
- Delete/Backspace no longer removes the selected annotation while a dialog is open.

[1.0.0]: https://github.com/krishnakantnagina/pdf-editor-app/releases/tag/v1.0.0
