require("dotenv").config();
const OpenAI = require('openai');
const express = require('express');
const { OPENAI_API_KEY, ASSISTANT_ID, SERPAPI_KEY } = process.env;
const twilio = require('twilio')
const { getJson } = require("serpapi");
const app = express();
app.use(express.urlencoded({ extended: true }));

const openai = new OpenAI({
    apiKey: OPENAI_API_KEY,
});

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const session = {}
const assistantId = ASSISTANT_ID;

async function getSearchResult(query) {
    const json = await getJson({
        engine: "google",
        api_key: SERPAPI_KEY,
        q: query,
        location: "India",
    });
    return json["organic_results"];
}

async function createThread() {
    console.log('Creating a new thread...');
    const thread = await openai.beta.threads.create();
    return thread;
}

async function addMessage(threadId, message) {
    console.log('Adding a new message to thread: ' + threadId);
    const response = await openai.beta.threads.messages.create(
        threadId,
        {
            role: "user",
            content: message
        }
    );
    return response;
}

const handleRunStatus = async (sessionId, run, res) => {
    const threadId = session[sessionId];
    if (run.status === "completed") {
      let messages = await openai.beta.threads.messages.list(threadId);
      console.log(JSON.stringify(messages.data));
      
      const output = JSON.parse(messages.data[0].content[0]['text']['value'])
      const concatenatedLinks = output.sources.reduce((res, link) => {
        return res + link + ", ";
      }, "");

      const response = 
      `*RESULT*
${output.description}

Here are the source: 
${concatenatedLinks}
`;
      await client.messages.create({
        body: response,
        from: process.env.TWILIO_WHATSAPP_NO,
        to: sessionId,
      });
    } else if (run.status === "requires_action") {
      console.log(run.status);
      return await handleRequiresAction(sessionId, run, res);
    } else {
      console.error("Run did not complete:", run);
    }
};

async function runAssistant(sessionId, res) {
    console.log('Running assistant for thread: ' + session[sessionId])
    run = await openai.beta.threads.runs.createAndPoll(session[sessionId], {
        assistant_id: assistantId,
    });
    await handleRunStatus(sessionId, run, res);
}

const handleRequiresAction = async (sessionId, runObject, res) => {
    const threadId = session[sessionId]
    if(runObject.required_action.type === 'submit_tool_outputs') {
        const tool_calls = await runObject.required_action.submit_tool_outputs.tool_calls
        const parsedArgs = JSON.parse(tool_calls[0].function.arguments);
        console.log(parsedArgs)
        const apiResponse = await getSearchResult(parsedArgs.query)   
        const run = await openai.beta.threads.runs.submitToolOutputsAndPoll(
            threadId,
            runObject.id,
            {
              tool_outputs: [
                {
                  tool_call_id: tool_calls[0].id,
                  output: JSON.stringify(apiResponse)
                },
              ],
            }
        )
        return handleRunStatus(sessionId, run, res);
    }
}

app.post('/message', async(req, res) => {
    const { Body, From } = req.body;
    const sessionId = From;
    res.send("Verifying the message...").status(200);
    if(!session.hasOwnProperty(sessionId)){
        const thread = await createThread();
        session[sessionId] = thread.id;
    }
    const threadId = session[sessionId]
    addMessage(threadId, Body).then(() => {
        runAssistant(sessionId, res);
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});