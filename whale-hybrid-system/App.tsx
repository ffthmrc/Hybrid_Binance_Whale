// ... (previous code)
const newPos = {
    // ... (other properties),
    alertType: alert.eliteType || alert.reason || 'UNKNOWN',
};

// ... (later in the code)
const historyItem = {
    // ... (other properties),
    alertType: newPos.alertType,
};
// ... (rest of the code)
