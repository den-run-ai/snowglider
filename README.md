# ❄️ SnowGlider ❄️
A cheerful snowman shredding mountain snow powder in a playful Three.js animation. ⛄️🎿

www.snowglider.ai

https://github.com/user-attachments/assets/699d795e-7c79-40b4-8a15-d7ab6cc27660


## Overview
SnowGlider is a Three.js-based skiing game featuring a snowman gliding down a procedurally generated mountain. The game includes realistic physics, terrain generation, tree obstacles, and specialized camera tracking.

## Features
- Smooth snowman skiing with realistic physics and terrain interaction
- Procedurally generated backcountry mountain terrain with natural features
- Tree obstacle detection with collision physics
- Snow particle effects that respond to speed and turning
- Tracking camera that follows the snowman's movements
- Timer with best time tracking
- Comprehensive test suite for verifying game mechanics

## Project Structure
- `index.html` - Main entry point and HTML structure
- `snowglider.js` - Core game loop and initialization
- `snowman.js` - Snowman model creation and physics
- `mountains.js` - Terrain generation and mountain features
- `trees.js` - Tree creation and placement
- `camera.js` - Camera management and tracking
- `snow.js` - Utility functions and snow effects
- `tests/` - Testing framework for game components

## Controls

### Keyboard Controls (Desktop)
- **Arrow Keys / WASD**: Control snowman direction
  - **Left Arrow / A**: Turn left
  - **Right Arrow / D**: Turn right
  - **Up Arrow / W**: Increase speed
  - **Down Arrow / S**: Slow down
- **Space**: Jump over obstacles
- **Reset Button**: Start a new run

### Touch Controls (Mobile)
- **Left Side of Screen**: Turn left
- **Right Side of Screen**: Turn right
- **Top of Screen**: Increase speed
- **Bottom of Screen**: Slow down
- **Center of Screen**: Jump
- **Reset Button**: Start a new run

The game automatically detects mobile devices and enables touch controls with visual indicators for easier gameplay.

## Testing
The game includes a comprehensive testing framework. Run tests by appending URL parameters:
- `?test=true` - Run basic gameplay tests
- `?test=trees` - Run tree collision tests
- `?test=camera` - Run camera tracking tests
- `?test=regression` - Run regression tests
- `?test=unified` - Run all tests

## Recent Improvements
- Fixed mobile authentication in Chrome with improved popup handling
- Enhanced error recovery for popup blocking and user cancellation
- Added optimized authentication flow for mobile browsers
- Implemented detailed debug mode for troubleshooting auth issues (add `?debug=auth` to URL)
- Added responsive visual feedback for authentication actions on mobile
- Added recovery mechanism for authentication errors with automatic retry options
- Added mobile-friendly touch controls with visual indicators for touchscreen devices
- Implemented adaptive control layout that adjusts to screen size and orientation
- Added automatic detection of mobile devices to enable appropriate controls
- Added Firebase authentication and user account system
- Implemented global leaderboard with top 10 player times
- Automatic score syncing between local storage and Firebase
- Converted terrain from groomed ski run to natural backcountry mountain
- Distributed trees and rocks throughout the entire mountain terrain
- Enhanced downhill gradient for consistent skiing experience
- Renamed utils.js to snow.js for better clarity of its purpose
- Refactored tree functionality into separate trees.js module
- Separated snowman functionality into its own module
- Fixed tree collision detection in extended terrain areas
- Improved camera tracking system with smooth transitions
- Added comprehensive test hooks for verifying game mechanics
- Enhanced snow particle effects with improved visuals

## Development

### Local Development Setup
1. Clone the repository
2. Install dependencies with `npm install`
3. Run locally using one of these options:
   - **Option 1:** Run with local server: `npm start` (full features)
   - **Option 2:** Open `index.html` directly in your browser (limited features)

#### Local Development Notes
- **Server mode (`npm start`):** 
  - Runs on `localhost` with HTTP protocol
  - Firebase Authentication works, but Firestore service is automatically disabled to prevent connection errors
  - A "Local Dev Mode: Firestore disabled" indicator will be displayed in the bottom-right corner
  - Best times are stored in localStorage and can be synced to Firebase when online

- **Direct browser mode (opening `index.html` directly):**
  - Uses the `file://` protocol 
  - All Firebase services (Authentication and Firestore) are automatically disabled
  - A "Local File Mode: Firebase disabled" indicator will be displayed
  - Login UI is hidden and replaced with a "Local Mode" message
  - Best times are only stored in localStorage
  - Perfect for quick testing without server setup

### Firebase Setup and Deployment

#### Firebase Configuration
1. Create a Firebase project at [console.firebase.google.com](https://console.firebase.google.com/)
2. Enable Google Authentication in the Firebase console
3. Create a Firestore database in the Firebase console
4. Register your web app in Firebase to get configuration keys
5. Update the Firebase configuration in `index.html` and `auth.html`:

```javascript
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId: "YOUR_APP_ID",
  measurementId: "YOUR_MEASUREMENT_ID"
};
```

#### Firestore Database Structure
The application uses the following Firestore collections:
- `users` - User profiles and best times
- `leaderboard` - Global leaderboard entries

#### GitHub Pages Deployment
1. Push your changes to GitHub repository
2. Enable GitHub Pages in repository settings
3. Make sure to add your GitHub Pages domain to the authorized domains in Firebase Authentication settings
4. Your game will be accessible at `https://[your-username].github.io/[repo-name]/`

## Troubleshooting

### Firebase Connection Issues
- If you see 400 errors when connecting to Firestore, ensure you're not running on `localhost` or `file://` protocol
- For local development, the app will automatically disable Firestore
- For production deployment, ensure your domain is authorized in Firebase console
- Check the browser console for specific error messages and Firebase status

### Mobile Authentication Issues
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

### CORS Errors When Opening Directly
- If you previously saw CORS errors when opening the game directly with `file://` protocol, this has been fixed
- The game now automatically detects the file:// protocol and provides a fallback implementation
- Authentication UI is hidden in this mode and replaced with a "Local Mode" indicator
- All core gameplay features will work without authentication

### GitHub Pages Deployment
- The GitHub Pages deployment will continue to work normally with the full set of features
- Authentication and leaderboard functionality will work properly on GitHub Pages as it uses HTTPS
- No special configuration is needed for GitHub Pages beyond the existing Firebase domain authorization
