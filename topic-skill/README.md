# Math Topic-Skill Matcher

This application helps match middle/high school math topics with relevant skills using OpenAI's GPT-4.1 model.

## Features

- Enter any math topic and get matched skills from the Skills.csv database
- Web interface for easy use
- API endpoint for programmatic access
- Responsive design for all devices

## Prerequisites

- Node.js (v14 or higher)
- OpenAI API key

## Installation

1. Clone the repository or download the source code
2. Install dependencies:
   ```
   npm install
   ```
3. Create a `.env` file in the root directory and add your OpenAI API key:
   ```
   OPENAI_API_KEY=your_openai_api_key_here
   ```

## Usage

1. Start the server:
   ```
   npm start
   ```
2. Open your browser and navigate to `http://localhost:3000`
3. Enter a math topic in the input field and click "Find Skills"
4. View the matched skills ordered by relevance

## API Usage

You can also use the API endpoint to get matched skills programmatically:

```javascript
// Example request
fetch('http://localhost:3000/api/match', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ topic: 'Pythagorean theorem' }),
})
.then(response => response.json())
.then(data => console.log(data));
```

## Files

- `server.js`: Main server file
- `Skills.csv`: Database of math skills
- `public/index.html`: Web interface

## Development

To run in development mode with automatic restarting:

```
npm install -g nodemon
npm run dev
```

## License

ISC 