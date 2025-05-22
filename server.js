require('dotenv').config(); // Load environment variables at the very top
const express = require('express');
const multer = require('multer');
// const pdfParse = require('pdf-parse'); // No longer primary, but keep for fallback or specific needs
const path = require('path');
const { exec } = require('child_process');
const tmp = require('tmp');
const fs = require('fs-extra'); // Using fs-extra for ensureDirSync and easy cleanup
const OpenAI = require('openai');

// Utility function to split text into smaller chunks of approximately 500-600 words
function splitIntoChunks(text, wordsPerChunk = 550) {
    // Split text into words
    const words = text.split(/\s+/);
    const chunks = [];
    
    // Create chunks of approximately wordsPerChunk words
    for (let i = 0; i < words.length; i += wordsPerChunk) {
        const chunk = words.slice(i, i + wordsPerChunk).join(' ');
        chunks.push(chunk);
    }
    
    return chunks;
}

// Utility function to extract school information from cleaned text
function extractSchoolInfo(cleanedText) {
    // Look for content before the first grade section
    const firstGradeIndex = cleanedText.indexOf('=== GRADE:');
    if (firstGradeIndex === -1) return cleanedText;
    
    // Return the text before the first grade section
    return cleanedText.substring(0, firstGradeIndex).trim();
}

// Utility function to split cleaned text into grade-specific chunks
function splitByGrade(cleanedText) {
    const gradeChunks = [];
    const gradeStartRegex = /===\s*GRADE:\s*([^=]+)\s*===/g;
    const gradeEndRegex = /===\s*END GRADE\s*===/g;
    
    let match;
    let lastIndex = 0;
    let gradeMatches = [];
    
    // Find all grade section markers
    while ((match = gradeStartRegex.exec(cleanedText)) !== null) {
        const gradeName = match[1].trim();
        const startIndex = match.index;
        
        // Find the end of this grade section
        gradeEndRegex.lastIndex = startIndex;
        const endMatch = gradeEndRegex.exec(cleanedText);
        
        if (endMatch) {
            const endIndex = endMatch.index + endMatch[0].length;
            
            // Store the grade name and its text section
            gradeMatches.push({
                gradeName,
                startIndex,
                endIndex,
                text: cleanedText.substring(startIndex, endIndex)
            });
            
            // Move last index
            lastIndex = endIndex;
            
            // Reset regex lastIndex to continue search after this grade
            gradeStartRegex.lastIndex = endIndex;
        }
    }
    
    // If no grade sections were found, return the entire text as one chunk
    if (gradeMatches.length === 0) {
        return [{
            gradeName: 'Unknown Grade',
            text: cleanedText
        }];
    }
    
    // Convert matches to grade chunks
    for (const match of gradeMatches) {
        gradeChunks.push({
            gradeName: match.gradeName,
            text: match.text
        });
    }
    
    return gradeChunks;
}

// Utility function to merge grade-specific curriculum data
function mergeCurriculumData(gradeResults, schoolName) {
    // Start with base structure
    const mergedData = {
        "Mathematics": {
            [schoolName]: {}
        }
    };
    
    // Merge each grade result
    for (const gradeData of gradeResults) {
        if (!gradeData || !gradeData.curriculum) continue;
        
        // Extract the subject and school names from the grade data
        const subjectNames = Object.keys(gradeData.curriculum);
        if (subjectNames.length === 0) continue;
        
        const subject = subjectNames[0]; // Should be "Mathematics"
        const schoolsInGrade = gradeData.curriculum[subject];
        if (!schoolsInGrade) continue;
        
        const schoolsArray = Object.keys(schoolsInGrade);
        if (schoolsArray.length === 0) continue;
        
        const school = schoolsArray[0];
        const gradesInSchool = schoolsInGrade[school];
        if (!gradesInSchool) continue;
        
        // Add each grade to the merged structure
        for (const gradeName of Object.keys(gradesInSchool)) {
            mergedData.Mathematics[schoolName][gradeName] = gradesInSchool[gradeName];
        }
    }
    
    return mergedData;
}

const app = express();
const port = 3000;

if (!process.env.OPENAI_API_KEY) {
    console.error('FATAL ERROR: OPENAI_API_KEY is not set. Please create a .env file with your API key.');
    process.exit(1); // Exit if API key is not found
}

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// Multer setup for handling file uploads (storing in memory)
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Serve static files from a 'public' directory (for HTML, CSS, client-side JS)
app.use(express.static(path.join(__dirname, 'public')));

// Ensure tmp module cleans up even on uncaught exceptions
tmp.setGracefulCleanup();

app.use(express.json()); // Add this line to parse JSON request bodies

// API endpoint for file upload and text extraction
app.post('/api/upload', upload.single('pdfFile'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded.' });
    }

    if (req.file.mimetype !== 'application/pdf') {
        return res.status(400).json({ error: 'Only PDF files are allowed.' });
    }

    // Create a temporary directory
    tmp.dir({ unsafeCleanup: true }, (err, tempDirPath, cleanupCallback) => {
        if (err) {
            console.error('Error creating temporary directory:', err);
            return res.status(500).json({ error: 'Failed to process PDF (temp dir error).' });
        }

        const pdfFileName = 'input.pdf'; // Use a fixed name within the temp dir
        const pdfPathInTempDir = path.join(tempDirPath, pdfFileName);
        const imageOutputPrefix = path.join(tempDirPath, 'page'); // pdftocairo will append e.g., '-01.png'

        // Write the buffer to the temporary PDF file
        fs.writeFile(pdfPathInTempDir, req.file.buffer, async (writeErr) => {
            if (writeErr) {
                console.error('Error writing PDF to temporary file:', writeErr);
                cleanupCallback(); // Clean up temp directory
                return res.status(500).json({ error: 'Failed to process PDF (temp write error).' });
            }

            // Execute pdftocairo to generate images
            const pdftocairoCommand = `pdftocairo -png "${pdfPathInTempDir}" "${imageOutputPrefix}"`;
            exec(pdftocairoCommand, async (imgErr, imgStdout, imgStderr) => {
                if (imgErr) {
                    console.error('Error executing pdftocairo:', imgErr);
                    console.error('pdftocairo stderr:', imgStderr);
                    cleanupCallback();
                    return res.status(500).json({ error: 'Failed to extract images from PDF.', details: imgStderr });
                }

                try {
                    const files = await fs.readdir(tempDirPath);
                    const imageFiles = files.filter(f => f.startsWith('page-') && f.endsWith('.png')).sort();
                    const pageImagesBase64 = [];
                    const aiResponses = [];
                    const BATCH_SIZE = 5;

                    for (let i = 0; i < imageFiles.length; i += BATCH_SIZE) {
                        const batchFiles = imageFiles.slice(i, i + BATCH_SIZE);
                        const batchPromises = batchFiles.map(async (imgFile, indexInBatch) => {
                            const pageNum = i + indexInBatch + 1;
                            try {
                                const imgPath = path.join(tempDirPath, imgFile);
                                const imgBuffer = await fs.readFile(imgPath);
                                const base64Image = Buffer.from(imgBuffer).toString('base64');
                                
                                const response = await openai.chat.completions.create({
                                    model: "gpt-4.1",
                                    messages: [
                                        {
                                            role: "user",
                                            content: [
                                                { type: "text", text: "Extract all text verbatim from this image. Do not summarize, interpret, or add any information not present in the text. Focus solely on accurate text extraction." },
                                                {
                                                    type: "image_url",
                                                    image_url: { "url": `data:image/png;base64,${base64Image}` },
                                                },
                                            ],
                                        },
                                    ],
                                    max_tokens: 1000, // Increased for potentially more text
                                });
                                return {
                                    page: pageNum,
                                    base64Image: base64Image, // Include image data here
                                    description: response.choices[0].message.content
                                };
                            } catch (aiError) {
                                console.error(`Error calling OpenAI for image ${imgFile} (page ${pageNum}):`, aiError.response ? aiError.response.data : aiError.message);
                                return {
                                    page: pageNum,
                                    base64Image: null, // Could try to read and send image even on AI fail
                                    error: 'Failed to get description from AI.',
                                    details: aiError.message
                                };
                            }
                        });
                        const batchResults = await Promise.all(batchPromises);
                        batchResults.forEach(result => {
                            if(result.base64Image) pageImagesBase64.push({page: result.page, image: result.base64Image}); // Storing with page for easier sorting later if needed
                            aiResponses.push({page: result.page, description: result.description, error: result.error, details: result.details});
                        });
                    }
                    
                    // Sort base64 images by page number before sending if they were pushed out of order
                    // (though current batching and pushing should maintain order of pages)
                    pageImagesBase64.sort((a, b) => a.page - b.page);
                    aiResponses.sort((a, b) => a.page - b.page);

                    res.json({
                        pageImages: pageImagesBase64.map(p => p.image), // Send only image data
                        aiAnalysis: aiResponses,
                    });

                } catch (processingError) {
                    console.error('Error processing images or calling AI:', processingError);
                    res.status(500).json({ error: 'Failed during image processing or AI analysis.' });
                }
                
                cleanupCallback();
            });
        });
    });
});

// Add a new endpoint to clean up text before structuring curriculum
app.post('/api/clean-text', async (req, res) => {
    try {
        if (!req.body.extractedText || !Array.isArray(req.body.extractedText) || req.body.extractedText.length === 0) {
            return res.status(400).json({ error: 'No extracted text provided.' });
        }

        const extractedText = req.body.extractedText.join('\n\n');
        console.log(`Processing extracted text of length: ${extractedText.length} characters`);
        
        // Step 1: Split the text into smaller chunks for processing
        const textChunks = splitIntoChunks(extractedText);
        console.log(`Split extracted text into ${textChunks.length} chunks for processing`);
        
        // Step 2: Process each chunk in parallel with a specific prompt
        const chunkPromises = textChunks.map(async (chunk, index) => {
            console.log(`Processing chunk ${index + 1}/${textChunks.length} (${chunk.length} chars)`);
            
            try {
                const chunkResponse = await openai.chat.completions.create({
                    model: "gpt-4.1",
                    messages: [
                        {
                            role: "system",
                            content: "You are a curriculum preprocessing assistant specialized in Mathematics curriculum. Your task is to clean text extracted from curriculum documents."
                        },
                        {
                            role: "user",
                            content: `Clean up the following CHUNK of text extracted from a Mathematics curriculum document.
                            
                            This is chunk ${index + 1} of ${textChunks.length}, so focus on:
                            1. Identifying any school information (name, state, website) if present
                            2. Identifying grade levels, units, and topics if present
                            3. Removing irrelevant information
                            
                            DO NOT add section markers or structure yet. Just clean the text in this chunk.
                            
                            Chunk text:
                            ${chunk}`
                        }
                    ],
                    max_tokens: 1500
                });
                
                return chunkResponse.choices[0].message.content;
            } catch (error) {
                console.error(`Error processing chunk ${index + 1}:`, error);
                // Return the original chunk if processing fails
                return chunk;
            }
        });
        
        // Wait for all chunks to be processed
        const processedChunks = await Promise.all(chunkPromises);
        const combinedCleanedText = processedChunks.join('\n\n');
        console.log(`Combined cleaned chunks, total length: ${combinedCleanedText.length} chars`);
        
        // Step 3: Final pass to structure the combined text with grade sections
        const finalCleanupResponse = await openai.chat.completions.create({
            model: "gpt-4.1",
            messages: [
                {
                    role: "system",
                    content: "You are a curriculum preprocessing assistant specialized in Mathematics curriculum. Your task is to organize and structure cleaned curriculum text."
                },
                {
                    role: "user",
                    content: `Organize the following cleaned Mathematics curriculum text into a structured format.
                    
                    IMPORTANT GUIDELINES:
                    1. The subject is ALWAYS Mathematics
                    2. Consider "Grade 6", "Grade 7", "Algebra", "Geometry", etc. as GRADE LEVELS
                    3. Keep ONLY the following information:
                       - School name, state, and website (no other school info)
                       - Grade levels (including Algebra, Geometry, etc.)
                       - Units of study 
                       - Topics within each unit
                    4. Remove all irrelevant information
                    
                    FORMAT REQUIREMENTS:
                    1. Start with school information as a separate section
                    2. For EACH grade level, create a clearly marked section with this EXACT format:
                       === GRADE: [Grade level name] ===
                       [Units and topics content for this grade]
                       === END GRADE ===
                    3. Make sure each grade section stands alone with its complete units and topics
                    
                    Here's the text to organize:
                    ${combinedCleanedText}`
                }
            ],
            max_tokens: 2500
        });

        const cleanedText = finalCleanupResponse.choices[0].message.content;
        console.log("Successfully cleaned and structured the text");
        console.log("Cleaned text sample (first 200 chars):", cleanedText.substring(0, 200));
        res.json({ cleanedText });
        
    } catch (error) {
        console.error('Error cleaning curriculum text:', error);
        res.status(500).json({ 
            error: 'Failed to clean curriculum text', 
            details: error.message
        });
    }
});

// Update the create curriculum endpoint
app.post('/api/create-curriculum', async (req, res) => {
    try {
        if (!req.body.cleanedText || typeof req.body.cleanedText !== 'string' || req.body.cleanedText.trim().length === 0) {
            return res.status(400).json({ error: 'No cleaned text provided.' });
        }

        const cleanedText = req.body.cleanedText;
        console.log(`Processing cleaned text of length: ${cleanedText.length} characters`);
        console.log("Cleaned text sample (first 200 chars):", cleanedText.substring(0, 200));

        // Extract school info section (before the first grade section)
        const schoolInfoText = extractSchoolInfo(cleanedText);
        console.log("Extracted school info section:", schoolInfoText.substring(0, 100) + "...");

        // Extract metadata from school info text
        console.log("Extracting metadata...");
        const metadataResponse = await openai.chat.completions.create({
            model: "gpt-4.1",
            messages: [
                {
                    role: "system",
                    content: "You are a curriculum assistant that extracts school metadata from curriculum documents."
                },
                {
                    role: "user",
                    content: `Extract ONLY the following metadata from the curriculum text:
                    1. School name
                    2. School state (full state name, not abbreviation)
                    3. A reasonable school website domain (for logo purposes)
                    
                    Format the response as a valid JSON object with these fields:
                    {
                        "schoolName": "Extracted school name or 'Unknown School' if not found",
                        "schoolState": "Extracted state name or 'Unknown' if not found",
                        "schoolLogo": "https://logo.clearbit.com/[school-website]"
                    }
                    
                    The curriculum text is:
                    ${schoolInfoText}`
                }
            ],
            response_format: { type: "json_object" },
            max_tokens: 500
        });

        // Parse metadata response
        console.log("Parsing metadata response...");
        let metadata;
        try {
            metadata = JSON.parse(metadataResponse.choices[0].message.content);
            console.log('Successfully parsed metadata:', metadata);
        } catch (parseError) {
            console.error('Metadata parse error:', parseError.message);
            // Create default metadata if parsing fails
            metadata = {
                "schoolName": "Unknown School",
                "schoolState": "Unknown State",
                "schoolLogo": "https://logo.clearbit.com/example.com"
            };
        }

        // Split the cleaned text into grade chunks
        const gradeChunks = splitByGrade(cleanedText);
        console.log(`Split text into ${gradeChunks.length} grade chunks`);
        
        // Process each grade chunk in sequence
        const gradeResults = [];
        for (const [index, gradeChunk] of gradeChunks.entries()) {
            console.log(`Processing grade chunk ${index + 1}/${gradeChunks.length}: ${gradeChunk.gradeName}`);
            
            try {
                // Create a simplified prompt for this grade only
                const gradePrompt = `
                For the Mathematics curriculum grade "${gradeChunk.gradeName}" at ${metadata.schoolName}, 
                analyze the following text and structure it as JSON according to these guidelines:
                
                1. The subject is "Mathematics"
                2. The school name is "${metadata.schoolName}"
                3. The grade name is "${gradeChunk.gradeName}"
                4. Include all units and their topics as they appear in the text
                5. All topics should have empty objects as values
                
                The text for this grade is:
                ${gradeChunk.text}`;
                
                // Call OpenAI for this grade chunk
                const response = await openai.chat.completions.create({
                    model: "gpt-4.1",
                    messages: [
                        {
                            role: "system",
                            content: "You are a curriculum structuring assistant specialized in Mathematics. Your task is to analyze curriculum documents and organize them into a specific tree structure."
                        },
                        {
                            role: "user",
                            content: `Analyze the curriculum text and structure it EXACTLY in the following JSON format:
                            
                            {
                              "Mathematics": {
                                "${metadata.schoolName}": {
                                  "${gradeChunk.gradeName}": {
                                    "unit1Name": {
                                        "Topic1Name": {},
                                        "Topic2Name": {},
                                    },
                                    "unit2Name": {
                                        "Topic3Name": {},
                                        "Topic4Name": {},
                                    }
                                  }
                                }
                              }
                            }
                            
                            IMPORTANT GUIDELINES:
                            1. The subject is ALWAYS "Mathematics"
                            2. The school name is ALREADY PROVIDED as "${metadata.schoolName}"
                            3. The grade name is ALREADY PROVIDED as "${gradeChunk.gradeName}"
                            4. Replace "unit1Name", "unit2Name" with actual unit names (like "Number Sense", "Fractions")
                            5. Replace "Topic1Name", "Topic2Name", etc. with actual topic names (like "Divisibility Factors")
                            6. All topics should have empty objects as values {}
                            7. Make sure your JSON is valid
                            
                            The text for this grade is:
                            ${gradeChunk.text}`
                        }
                    ],
                    response_format: { type: "json_object" },
                    max_tokens: 2000
                });
                
                // Parse the response for this grade
                const gradeData = JSON.parse(response.choices[0].message.content);
                console.log(`Successfully processed grade: ${gradeChunk.gradeName}`);
                gradeResults.push({ curriculum: gradeData });
            } catch (gradeError) {
                console.error(`Error processing grade ${gradeChunk.gradeName}:`, gradeError);
                // Continue with other grades if one fails
            }
        }
        
        // Merge all grade results into a single curriculum structure
        const mergedCurriculum = mergeCurriculumData(gradeResults, metadata.schoolName);
        console.log("Successfully merged curriculum data for all grades");
        
        // Send the combined result
        console.log("Sending response to client...");
        res.json({
            metadata: metadata,
            curriculum: mergedCurriculum
        });
    } catch (error) {
        console.error('Error creating curriculum structure:', error);
        
        // Enhanced error response
        res.status(500).json({ 
            error: 'Failed to create curriculum structure', 
            details: error.message
        });
    }
});

app.listen(port, () => {
    console.log(`Server listening at http://localhost:${port}`);
}); 