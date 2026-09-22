# Active patient Web

This directory serves the active patient-facing Web application at `/patient-web/`.

- Patient pages and their assets are preserved from `archive/legacy-patient-web/`.
- `login.html`, `css/login.css`, and `js/login.js` come from the original complete Web application.
- The only login behavior adjustment routes researcher accounts to the active `/doctor-web/` application.
- Both Web applications use the same `/api/v1` backend, authentication, and database.

The archive remains the immutable provenance copy. Do not serve the archive or repository root as static files.
