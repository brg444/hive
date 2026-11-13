// The console builds no transaction and talks to no execution route.
const none = () => {
    throw new Error("the keeper console does not execute spends");
};
export const executionOrder = () => [];
export const buildSpend = none;
export const executionState = none;
export const executionAttempts = none;
export const delegateeRoute = none;
export const selfRoute = none;
export const restEmulator = none;
export const Router = class {
    constructor() {
        none();
    }
};
export default {};
export const observeSpend = none;
export const validateCheckpoint = none;
