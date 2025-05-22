require('dotenv').config();
const express = require('express');
const fs = require('fs');
const csv = require('csv-parser');
const OpenAI = require('openai');
const path = require('path');

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// In-memory cache for skills
let skillsCache = null;

// Function to read and parse CSV file
function readCSV() {
  return new Promise((resolve, reject) => {
    if (skillsCache) {
      return resolve(skillsCache);
    }

    const results = [];
    fs.createReadStream('Skills.csv')
      .pipe(csv())
      .on('data', (data) => results.push(data))
      .on('end', () => {
        skillsCache = results;
        resolve(results);
      })
      .on('error', (error) => reject(error));
  });
}

// Function to match topic with skills using OpenAI in batches
async function matchTopicWithSkills(topic, allSkills) {
  try {
    // Split skills into batches of 100
    const batchSize = 100;
    const skillBatches = [];
    
    for (let i = 0; i < allSkills.length; i += batchSize) {
      skillBatches.push(allSkills.slice(i, i + batchSize));
    }
    
    console.log(`Processing ${allSkills.length} skills in ${skillBatches.length} batches of ${batchSize} each`);
    
    // Process each batch in parallel
    const batchPromises = skillBatches.map(async (skills, batchIndex) => {
      try {
        // Convert skills to a simpler format for the prompt
        const skillsText = skills.map(skill => 
          `Domain: ${skill.Domain}, Topic: ${skill.Topic}, Skill: ${skill.Skill}, Sub-skill: ${skill['Sub-skill']}`
        ).join('\n');
        
        console.log(`Batch ${batchIndex + 1}/${skillBatches.length} prepared with ${skills.length} skills`);

        // Create prompt for OpenAI
        const prompt = `
        Given the following middle/high school math topic: "${topic}"
        
        Find ALL skills from the below list that are related to this topic and assign relevancy scores to them based on these principles:
        
        RELEVANCY SCORING GUIDELINES:
        - Score 95-100: Core skills that are EXACTLY what the topic is about (direct match to the topic name or its primary components)
        - Score 85-94: Skills that are very closely related and typically taught as part of this topic
        - Score 70-84: Skills that are related but may be extensions or applications of the topic
        - Score 50-69: Skills that have some connection but aren't central to the topic
        - Score below 50: Skills with only tangential connections
        
        IMPORTANT:
        1. If a sub-skill is specifically a core component mentioned in the topic name, it should get 95-100
        2. ALL sub-skills that are clearly part of learning the topic should receive high scores (85+)
        3. If a topic contains multiple components (like "Mean, Median, and Range"), treat EACH component as a core skill
        4. Order results by relevance (most relevant first)
        
        Format the output as a JSON array of objects with Domain, Topic, Skill, Sub-skill, and RelevancyScore properties.
        
        Skills list (batch ${batchIndex + 1}/${skillBatches.length}):
        ${skillsText}
        `;

        // Call OpenAI API
        const completion = await openai.chat.completions.create({
          model: "gpt-4o",  // Using GPT-4o as a more widely available model
          messages: [
            { 
              role: "system", 
              content: "You are a precise education curriculum matcher with expertise in identifying and scoring relevant skills for specific topics. You understand that if a topic has multiple components (like 'Mean, Median, and Range'), each component should be treated as equally core to the topic. You understand educational contexts and can accurately determine how directly a skill relates to teaching or learning a topic. Return your response as valid JSON with an array of skills that includes a RelevancyScore property (0-100) for each skill."
            },
            { role: "user", content: prompt }
          ],
          max_tokens: 1500,
          response_format: { type: "json_object" }
        });

        // Try to parse the response as JSON
        const content = completion.choices[0].message.content;
        console.log(`Received response for batch ${batchIndex + 1}/${skillBatches.length}`);
        
        let batchResults;
        try {
          batchResults = JSON.parse(content);
        } catch (parseError) {
          console.error(`JSON parse error in batch ${batchIndex + 1}:`, parseError);
          console.error('JSON content with error:', content);
          return {
            batchIndex,
            skills: [],
            error: `Failed to parse JSON for batch ${batchIndex + 1}: ${parseError.message}`
          };
        }
        
        // Return the results with the batch information
        return {
          batchIndex,
          skills: batchResults.skills || []
        };
      } catch (batchError) {
        console.error(`Error processing batch ${batchIndex + 1}:`, batchError);
        return {
          batchIndex,
          skills: [],
          error: `Failed to process batch ${batchIndex + 1}: ${batchError.message}`
        };
      }
    });
    
    // Wait for all batches to complete
    const batchResults = await Promise.all(batchPromises);
    console.log('All batches processed');
    
    // Combine and sort results from all batches
    let allMatchedSkills = [];
    let errors = [];
    
    batchResults.forEach(result => {
      if (result.skills && result.skills.length > 0) {
        allMatchedSkills = allMatchedSkills.concat(result.skills);
      }
      if (result.error) {
        errors.push(result.error);
      }
    });
    
    // Sort skills by relevance if needed (assuming the model already returns them sorted)
    
    // Return the combined results
    return {
      skills: allMatchedSkills,
      errors: errors.length > 0 ? errors : undefined,
      batchesProcessed: batchResults.length
    };
  } catch (error) {
    console.error('Error in matchTopicWithSkills:', error);
    return { error: 'Failed to match topic with skills', details: error.message };
  }
}

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/match', async (req, res) => {
  try {
    const { topic, grade } = req.body;
    
    if (!topic) {
      return res.status(400).json({ error: 'Topic is required' });
    }

    // Read skills from CSV
    const skills = await readCSV();
    console.log(`Using ${skills.length} skills for matching with topic: ${topic}`);
    
    // Match topic with skills
    const matchedSkills = await matchTopicWithSkills(topic, skills);
    
    // Categorize skills if grade is provided - only shortlisted ones (relevancy >= 80)
    if (grade && matchedSkills.skills && matchedSkills.skills.length > 0) {
      const shortlistedSkills = matchedSkills.skills.filter(skill => skill.RelevancyScore >= 80);
      if (shortlistedSkills.length > 0) {
        const categorizedSkills = await categorizeSkillsStandards(topic, grade, shortlistedSkills, 'skills');
        // Replace shortlisted skills with categorized ones, keep others as is
        matchedSkills.skills = matchedSkills.skills.map(skill => {
          const categorized = categorizedSkills.find(cat => 
            cat.Domain === skill.Domain && 
            cat.Topic === skill.Topic && 
            cat.Skill === skill.Skill && 
            cat['Sub-skill'] === skill['Sub-skill']
          );
          return categorized || skill;
        });
      }
    }
    
    // Return results
    res.json(matchedSkills);
  } catch (error) {
    console.error('Error in /api/match:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// API endpoint for state standards
app.post('/api/standards', async (req, res) => {
  try {
    const { topic, state, grade } = req.body;
    
    if (!topic || !state) {
      return res.status(400).json({ error: 'Topic and state are required' });
    }

    console.log(`Fetching standards for topic: "${topic}", state: "${state}"`);
    
    // Find state standards using OpenAI
    let standards = await findStateStandards(topic, state);
    
    // Categorize standards if grade is provided - only shortlisted ones (relevancy >= 75)
    if (grade && standards && standards.length > 0) {
      const shortlistedStandards = standards.filter(standard => standard.relevancyScore >= 75);
      if (shortlistedStandards.length > 0) {
        const categorizedStandards = await categorizeSkillsStandards(topic, grade, shortlistedStandards, 'standards');
        // Replace shortlisted standards with categorized ones, keep others as is
        standards = standards.map(standard => {
          const categorized = categorizedStandards.find(cat => cat.code === standard.code);
          return categorized || standard;
        });
      }
    }
    
    res.json({ standards });
  } catch (error) {
    console.error('Error in /api/standards:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Function to find state standards using OpenAI
async function findStateStandards(topic, state) {
  try {
    // Normalize the state name for better matching
    let stateForPrompt = state;
    if (state === "Common Core") {
      stateForPrompt = "Common Core State Standards (CCSS)";
    }
    
    const prompt = `Find the most relevant ${stateForPrompt} educational standards for the topic: "${topic}".

For Common Core, look for standards like:
- CCSS.MATH.6.EE.A.2 (6th grade Expressions & Equations)  
- CCSS.MATH.8.EE.C.7 (8th grade Linear equations)
- CCSS.MATH.HSA.REI.B.3 (High School Algebra)

For state standards, look for the actual state standard codes and descriptions.

Return results in this exact JSON format:
{
  "standards": [
    {
      "code": "CCSS.MATH.6.EE.A.2",
      "description": "Write, read, and evaluate expressions in which letters stand for numbers",
      "relevancyScore": 95
    }
  ]
}

If no relevant standards are found, return:
{
  "standards": []
}

Focus on standards that directly teach or assess the topic. The relevancyScore should be 75-100 for highly relevant standards.`;
    
    console.log('OpenAI prompt:', prompt);
    
    // Call OpenAI API
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { 
          role: "system", 
          content: "You are an educational standards expert with deep knowledge of Common Core State Standards and state-specific standards. Always return valid JSON with a 'standards' array. If no standards are found, return an empty array, never null. Each standard must have 'code', 'description', and 'relevancyScore' properties."
        },
        { role: "user", content: prompt }
      ],
      max_tokens: 2000,
      temperature: 0.2,
      response_format: { type: "json_object" }
    });

    // Parse the response
    const content = completion.choices[0].message.content;
    console.log('OpenAI response:', content);
    
    try {
      const results = JSON.parse(content);
      
      // Handle various response formats and null cases
      let standards = [];
      if (results.standards && Array.isArray(results.standards)) {
        standards = results.standards;
      } else if (results.standards === null || results.standards === undefined) {
        console.log('OpenAI returned null/undefined standards, treating as empty array');
        standards = [];
      } else {
        console.log('Unexpected standards format:', typeof results.standards, results.standards);
        standards = [];
      }
      
      // Sort by relevancy score (highest first)
      standards.sort((a, b) => (b.relevancyScore || 0) - (a.relevancyScore || 0));
      
      console.log(`Found ${standards.length} standards`);
      return standards;
    } catch (parseError) {
      console.error('Error parsing OpenAI response:', parseError);
      console.error('Raw content:', content);
      return [];
    }
  } catch (error) {
    console.error('Error finding state standards:', error);
    return [];
  }
}

// Function to categorize skills/standards as Core or Foundational
async function categorizeSkillsStandards(topic, grade, items, type) {
  try {
    if (!items || items.length === 0) {
      return items;
    }

    let processedItems;
    if (type === 'skills') {
      // Group by skill level instead of sub-skill level
      const skillGroups = {};
      items.forEach(item => {
        const skillKey = `${item.Domain} > ${item.Topic} > ${item.Skill}`;
        if (!skillGroups[skillKey]) {
          skillGroups[skillKey] = {
            Domain: item.Domain,
            Topic: item.Topic,
            Skill: item.Skill,
            subSkills: [],
            RelevancyScore: item.RelevancyScore
          };
        }
        skillGroups[skillKey].subSkills.push(item['Sub-skill']);
        // Use highest relevancy score if multiple sub-skills
        skillGroups[skillKey].RelevancyScore = Math.max(skillGroups[skillKey].RelevancyScore, item.RelevancyScore || 0);
      });
      processedItems = Object.values(skillGroups);
    } else {
      processedItems = items;
    }

    const itemsText = processedItems.map(item => {
      if (type === 'skills') {
        return `${item.Domain} > ${item.Topic} > ${item.Skill} (Sub-skills: ${item.subSkills.join(', ')})`;
      } else {
        return `${item.code}: ${item.description}`;
      }
    }).join('\n');

    const prompt = `You are given a topic, grade, and the suggested ${type} for it. As a math Teacher and Curriculum Expert, I need you to categorize whether the given skill or standard is a core skill that is going to be taught in this topic and in this grade. Or is this a foundational or a pre-req skill or a standard that is from a lower grade.

Topic: ${topic}
Grade: ${grade}
${type === 'skills' ? 'Skills' : 'Standards'}:
${itemsText}

IMPORTANT RULES:
${type === 'standards' ? 
`- For standards: Only classify as "Foundational" if the standard is from a LOWER grade than ${grade}
- Standards from grade ${grade} or HIGHER should be classified as "Core"
- Extract the grade level from the standard code (e.g., CCSS.MATH.6.EE.A.2 is grade 6, CCSS.MATH.HSA.REI.B.3 is high school)` :
`- For skills: "Core" means the skill is directly taught at grade ${grade} for this topic
- "Foundational" means the skill is a prerequisite typically taught in lower grades`}

Example JSON format:
{
  "categorized": [
    {
      "index": 0,
      "category": "Core"
    },
    {
      "index": 1,
      "category": "Foundational"
    }
  ]
}

Where "index" corresponds to the position in the original list (0-based)`;

    console.log(`Categorizing ${processedItems.length} ${type} for topic: ${topic}, grade: ${grade}`);

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { 
          role: "system", 
          content: `You are a math curriculum expert. For standards, only classify as 'Foundational' if they are from a lower grade level than the target grade. For skills, categorize based on whether they are typically taught at the target grade level or are prerequisites from earlier grades. Always return valid JSON.`
        },
        { role: "user", content: prompt }
      ],
      max_tokens: 1500,
      temperature: 0.2,
      response_format: { type: "json_object" }
    });

    const content = completion.choices[0].message.content;
    console.log('Categorization response:', content);

    try {
      const results = JSON.parse(content);
      const categorized = results.categorized || [];

      if (type === 'skills') {
        // Map categorization back to original sub-skills
        const itemsWithCategories = [];
        processedItems.forEach((skillGroup, index) => {
          const categoryInfo = categorized.find(cat => cat.index === index);
          const category = categoryInfo ? categoryInfo.category : 'Core';
          
          // Apply category to all sub-skills in this skill group
          const originalItems = items.filter(item => 
            item.Domain === skillGroup.Domain && 
            item.Topic === skillGroup.Topic && 
            item.Skill === skillGroup.Skill
          );
          
          originalItems.forEach(item => {
            itemsWithCategories.push({
              ...item,
              category: category
            });
          });
        });
        
        console.log(`Categorized ${itemsWithCategories.length} skills at skill level`);
        return itemsWithCategories;
      } else {
        // For standards, directly apply categorization
        const itemsWithCategories = processedItems.map((item, index) => {
          const categoryInfo = categorized.find(cat => cat.index === index);
          return {
            ...item,
            category: categoryInfo ? categoryInfo.category : 'Core'
          };
        });

        console.log(`Categorized ${itemsWithCategories.length} standards`);
        return itemsWithCategories;
      }
    } catch (parseError) {
      console.error('Error parsing categorization response:', parseError);
      // Return original items with default Core category
      return items.map(item => ({ ...item, category: 'Core' }));
    }
  } catch (error) {
    console.error('Error categorizing items:', error);
    // Return original items with default Core category
    return items.map(item => ({ ...item, category: 'Core' }));
  }
}

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
}); 