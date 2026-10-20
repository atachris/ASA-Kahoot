# USC ASA Trivia

Kahoot-style live quiz. No dependencies, Node 18+.

Run locally: `node server.js`, then open `http://localhost:3000/host`.
Players open the same address on their phones and enter the code.

Edit questions in `questions.js`. Change the timer with `QUESTION_SECONDS=30 node server.js`.

Deploy: any Node host (Render, Railway, Fly). Start command: `node server.js`. No build step.
