const fs = require('fs');
const csv = require('csv-parser');

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

// Main function
async function main() {
  try {
    // Read skills from CSV
    const skills = await readCSV();
    console.log(`Loaded ${skills.length} skills from CSV.`);

    // Convert skills to format used in prompt
    const skillsText = skills.map(skill => 
      `Domain: ${skill.Domain}, Topic: ${skill.Topic}, Skill: ${skill.Skill}, Sub-skill: ${skill['Sub-skill']}`
    ).join('\n');
    
    console.log('\nSKILLS TEXT FORMAT:');
    console.log(skillsText);
    
  } catch (error) {
    console.error('Error:', error);
  }
}

// Run the main function
main(); 