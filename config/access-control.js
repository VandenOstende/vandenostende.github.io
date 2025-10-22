/**
 * Toegangsbeheer configuratie
 * Definieert welke gebruikers welke tags hebben en welke apps welke tags vereisen
 */

const ACCESS_CONFIG = {
    // Gebruikers en hun toegewezen tags
    users: {
        'kevin.vanden.ostende@indaver.com': ['Indaver INEOS', 'Admin', 'pre-production'],
        'geoffrey.janssens@indaver.com': ['Indaver INEOS'],
        'jane.smith@example.com': ['General Access'],
        'test.gebruiker@example.com': ['Indaver INEOS'],
        // Voeg hier meer gebruikers toe
    },
    
    // Apps en hun vereiste tags (als gebruiker minstens één van deze tags heeft, krijgt hij toegang)
    apps: {
        'waste-request-dashboard': {
            name: 'Waste Request Dashboard',
            description: 'Dashboard voor het beheren en monitoren van afvalverzoeken en ophaaladministratie.',
            requiredTags: ['pre-production', 'Admin'],
            url: '/files/WasteRequestDash/',
            icon: '🗑️'
        },
        'waste-recipients-dashboard': {
            name: 'Waste Recipients Dashboard',
            description: 'Overzicht en analyse van afvalontvangers en verwerking statistieken.',
            requiredTags: ['Indaver INEOS', 'Admin'],
            url: '/files/WasteRecipientsDash/',
            icon: '📊'
        },
        // Voeg hier meer apps toe
    },
    
    // Tag definities met beschrijvingen en kleuren
    tags: {
        'Indaver INEOS': {
            description: 'Toegang voor Indaver INEOS medewerkers',
            color: '#3b82f6'
        },
        'Admin': {
            description: 'Volledige administratieve toegang',
            color: '#ef4444'
        },
        'General Access': {
            description: 'Algemene toegang voor basis functionaliteit',
            color: '#10b981'
        }
    }
};

/**
 * Controleer of een gebruiker toegang heeft tot een app
 * @param {string} userEmail - Email van de gebruiker
 * @param {string} appId - ID van de app
 * @returns {boolean} - True als gebruiker toegang heeft
 */
function hasAccess(userEmail, appId) {
    const userTags = ACCESS_CONFIG.users[userEmail] || [];
    const app = ACCESS_CONFIG.apps[appId];
    
    if (!app) return false;
    
    // Controleer of de gebruiker minstens één van de vereiste tags heeft
    return app.requiredTags.some(tag => userTags.includes(tag));
}

/**
 * Haal alle apps op waartoe een gebruiker toegang heeft
 * @param {string} userEmail - Email van de gebruiker
 * @returns {Array} - Array met app objecten waartoe de gebruiker toegang heeft
 */
function getUserApps(userEmail) {
    const userTags = ACCESS_CONFIG.users[userEmail] || [];
    const accessibleApps = [];
    
    for (const [appId, appConfig] of Object.entries(ACCESS_CONFIG.apps)) {
        const hasRequiredTag = appConfig.requiredTags.some(tag => userTags.includes(tag));
        if (hasRequiredTag) {
            accessibleApps.push({
                id: appId,
                ...appConfig
            });
        }
    }
    
    return accessibleApps;
}

/**
 * Haal de tags van een gebruiker op
 * @param {string} userEmail - Email van de gebruiker
 * @returns {Array} - Array met tag strings
 */
function getUserTags(userEmail) {
    return ACCESS_CONFIG.users[userEmail] || [];
}

/**
 * Haal alle geregistreerde gebruikers op
 * @returns {Array} - Array met email addresses
 */
function getAllUsers() {
    return Object.keys(ACCESS_CONFIG.users);
}

// Export voor gebruik in andere bestanden
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ACCESS_CONFIG, hasAccess, getUserApps, getUserTags, getAllUsers };
}
