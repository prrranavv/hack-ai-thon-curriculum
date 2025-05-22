require('dotenv').config();
const fs = require('fs');
const csv = require('csv-parser');
const readline = require('readline');
const OpenAI = require('openai');

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Create readline interface for user input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Function to read and parse CSV file
function readCSV() {
  return new Promise((resolve, reject) => {
    const results = [];
    fs.createReadStream('Skills.csv')
      .pipe(csv())
      .on('data', (data) => results.push(data))
      .on('end', () => resolve(results))
      .on('error', (error) => reject(error));
  });
}

// Function to match topic with skills using OpenAI
async function matchTopicWithSkills(topic, skills) {
  try {
    // Convert skills to a simpler format for the prompt
    const skillsText = skills.map(skill => 
      `Domain: ${skill.Domain}, Topic: ${skill.Topic}, Skill: ${skill.Skill}, Sub-skill: ${skill['Sub-skill']}`
    ).join('\n');

    // Create prompt for OpenAI
    const prompt = `
    Given the following middle/high school math topic: "${topic}"
    
    Find the most relevant skills from the below list. Return only the skills that match this topic, ordered by relevance.
    
    Skills list:
    ${skillsText}
    `;

    // Call OpenAI API
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",  // Using GPT-4o as a more widely available model
      messages: [
        { role: "system", content: "You are a helpful assistant that matches educational topics with relevant skills." },
        { role: "user", content: prompt }
      ],
      max_tokens: 1000
    });

    return completion.choices[0].message.content;
  } catch (error) {
    console.error('Error calling OpenAI:', error);
    return 'Failed to match topic with skills.';
  }
}

// Main function
async function main() {
  try {
    // Read skills from CSV
    const skills = await readCSV();
    console.log(`Loaded ${skills.length} skills from CSV.`);

    // Get user input
    rl.question('Enter a middle/high school math topic: ', async (topic) => {
      console.log(`Finding skills related to: ${topic}`);
      
      // Match topic with skills
      const matchedSkills = await matchTopicWithSkills(topic, skills);
      
      // Display results
      console.log('\nMatched Skills:');
      console.log(matchedSkills);
      
      rl.close();
    });
  } catch (error) {
    console.error('Error:', error);
    rl.close();
  }
}

// Run the main function
main(); 