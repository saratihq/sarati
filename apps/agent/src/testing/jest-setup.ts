// Runs before the modules under test are imported, which is the only point
// where this lands: LoggerModule reads LOG_LEVEL when app.module.ts is
// evaluated, so a spec setting it in beforeEach is already too late.
process.env.LOG_LEVEL = 'silent';
