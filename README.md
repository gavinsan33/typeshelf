# Typeshelf

Personal typing-practice site modeled on typelit.io: type through public-domain books page by page, with live WPM/accuracy and progress saved in `localStorage`. Static HTML/JS, served by GitHub Pages.

- Add or change books in `tools/build_books.py`, then run `python3 tools/build_books.py` (downloads texts and covers from Project Gutenberg into `books/` and `covers/`).
- Local preview: `python3 -m http.server`.
- Custom tab: upload EPUBs (DRM-free) or paste text. Books are stored in IndexedDB, progress in localStorage, both only in this browser.
