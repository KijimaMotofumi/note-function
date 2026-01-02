const { app } = require('@azure/functions');

// Register HTTP triggers (app.http) by requiring the module(s).
require('./functions/note-push');

app.setup({
    enableHttpStream: true,
});
