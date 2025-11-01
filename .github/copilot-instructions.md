# GitHub Copilot Instructions for vandenostende.github.io

## Project Overview

This is a GitHub Pages website serving as an app hosting platform. The site provides access-controlled web applications for authorized users.

**Tech Stack:**
- Pure HTML, CSS, and JavaScript (no build process)
- GitHub Pages for hosting
- Client-side access control system
- Responsive design with modern CSS animations

## Repository Structure

```
.
├── index.html              # Main landing page
├── script.js               # Main JavaScript functionality
├── style.css               # Main stylesheet
├── config/
│   └── access-control.js   # Access control configuration
├── files/                  # Hosted applications and assets
├── CNAME                   # Custom domain configuration
└── README.md               # Project documentation
```

## Code Style and Best Practices

### JavaScript
- Use modern ES6+ syntax
- Prefer `const` and `let` over `var`
- Use arrow functions for callbacks
- Add JSDoc comments for functions
- Keep functions focused and single-purpose
- Use descriptive variable names (e.g., `userEmail`, `appConfig`, not `x`, `y`)

### HTML
- Use semantic HTML5 elements
- Include proper ARIA labels for accessibility
- Keep structure clean and well-indented
- Use Dutch language (`lang="nl"`) for user-facing content

### CSS
- Use CSS variables for colors and spacing (defined in `:root`)
- Follow mobile-first responsive design
- Use flexbox/grid for layouts
- Keep animations subtle and performant
- Maintain consistent naming conventions

### File Organization
- Keep configuration separate in `config/` directory
- Place hosted apps in `files/` subdirectories
- Don't modify CNAME unless explicitly requested

## Access Control System

The site uses a tag-based access control system defined in `config/access-control.js`:

**Key Components:**
- `ACCESS_CONFIG.users`: Maps email addresses to tags
- `ACCESS_CONFIG.apps`: Defines apps with required tags and metadata
- `ACCESS_CONFIG.tags`: Tag definitions with descriptions and colors
- `hasAccess()`: Function to check user access to specific apps
- `getUserApps()`: Function to retrieve apps accessible to a user

**When modifying access control:**
- Always validate email format
- Keep tag names consistent
- Ensure all apps have valid URLs
- Test access logic thoroughly
- Don't remove existing users without confirmation

## Common Tasks

### Adding a New App
1. Add app configuration to `ACCESS_CONFIG.apps` in `config/access-control.js`
2. Specify required tags for access
3. Include app name, description, URL, and icon emoji
4. Ensure the app files are in the `files/` directory

### Adding a New User
1. Add user email to `ACCESS_CONFIG.users` in `config/access-control.js`
2. Assign appropriate tags
3. Verify the user can access expected apps

### Modifying Styles
1. Check if a CSS variable exists in `:root` before adding new colors/values
2. Test responsive behavior on mobile, tablet, and desktop
3. Ensure animations remain performant
4. Maintain dark theme aesthetics

## Testing and Validation

### Before Submitting Changes:
- Test in a local browser (use `python -m http.server` or similar)
- Verify responsive design on different screen sizes
- Check console for JavaScript errors
- Validate HTML structure
- Test access control logic with different user scenarios
- Ensure no sensitive data is committed

### Manual Testing:
- Open the site in a browser
- Test email prompt functionality
- Verify app cards display correctly
- Check navigation and smooth scrolling
- Test cookie consent functionality

## Security Considerations

- **Be cautious with user emails and personal data** - Verify repository visibility before committing any sensitive information
- Don't expose sensitive URLs or internal endpoints
- Validate all user inputs
- Use HTTPS for any external resources
- Keep localStorage usage minimal and appropriate
- Don't include API keys or credentials in code

## Documentation Standards

- Update README.md when adding major features
- Add inline comments for complex logic
- Document configuration changes
- Keep the project overview section current

## Known Constraints

- This is a static site (no backend/server-side processing)
- Access control is client-side only (not suitable for highly sensitive data)
- GitHub Pages limitations apply (no server-side logic, no databases)
- Files may have mixed line endings (CRLF and LF) - maintain consistency within each file

## Language Guidelines

- User-facing content should be in Dutch
- Code comments can be in Dutch or English (currently mixed)
- Variable names and function names should be in English
- Error messages and prompts should be in Dutch

## When in Doubt

- Maintain existing code style and patterns
- Keep changes minimal and focused
- Ask for clarification if requirements are unclear
- Test thoroughly before submitting
- Document any assumptions made

## Useful Commands

```bash
# Serve locally for testing
python -m http.server 8000
# or
npx http-server

# Check for JavaScript errors (if installed)
eslint script.js config/access-control.js

# View git status
git status
```

## Resources

- [GitHub Pages Documentation](https://docs.github.com/en/pages)
- [MDN Web Docs](https://developer.mozilla.org/)
- [CSS-Tricks](https://css-tricks.com/)
