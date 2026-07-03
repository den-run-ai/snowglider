# Troubleshooting & Diagnostics

Diagnostic tips, debug overlays, and logging guidance for running SnowGlider
locally and in production. For the module system, Firebase/scoring subsystem,
and load order see [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Firebase Connection Issues
- If you see 400 errors when connecting to Firestore, ensure you're not running on `localhost` or `file://` protocol
- For local development, the app will automatically disable Firestore
- For production deployment, ensure your domain is authorized in Firebase console
- Check the browser console for specific error messages and Firebase status

## Mobile Authentication Issues
- If you're experiencing issues with the sign-in button on mobile, try the following:
  - Ensure cookies and local storage are enabled in your mobile browser
  - Try using the "Retry Login" button if it appears after a failed authentication attempt
  - Clear browser cache and cookies, then try again
  - Ensure you have a stable internet connection
- For detailed debugging:
  - Add `?debug=auth` to the URL to enable the authentication debug overlay
  - Check the debug overlay for specific error messages and authentication status
  - Console logs will provide additional details about the authentication process
- Mobile devices now use popup-based authentication for better compatibility with Chrome and other mobile browsers

## CORS Errors When Opening Directly
- Direct `file://` opens are no longer a supported run mode.
- Use `npm run dev`, `npm start`, or serve the `dist/` output from `npm run build`.

## GitHub Pages Deployment
- The GitHub Pages deployment will continue to work normally with the full set of features
- Authentication and leaderboard functionality will work properly on GitHub Pages as it uses HTTPS
- No special configuration is needed for GitHub Pages beyond the existing Firebase domain authorization
