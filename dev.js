const app = require('./api/index');

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Chat server on http://localhost:${PORT}`);
});
