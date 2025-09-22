
let isGenerating = false; // prevent duplicate Gemini calls

//prevent too many calls in a short time
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeFetch(url, options, msDelay = 2000) {
  await delay(msDelay); // wait before calling
  return fetch(url, options);
}

async function getUserFirstName() {
  const cached = await new Promise((resolve) => {
    chrome.storage.local.get("firstName", (data) => resolve(data.firstName));
  });

  if (cached) {
    console.log("Using cached first name:", cached);
    return cached;
  }

  const token = await new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, (t) => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
      resolve(t);
    });
  });

  const res = await safeFetch(
    "https://people.googleapis.com/v1/people/me?personFields=names",
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!res.ok) throw new Error("Failed to fetch user profile");

  const data = await res.json();
  const firstName = data.names?.[0]?.givenName || "";

  chrome.storage.local.set({ firstName });
  return firstName;
}

function setResponseText(text) {
  const el = document.getElementById("response");
  if (el) {
    el.textContent = text;
  } else {
    console.warn("No #response element found in popup (popup might be closed). Message:", text);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  const loginBtn = document.getElementById("loginBtn");
  if (loginBtn) {
    loginBtn.addEventListener("click", () => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs[0] || !tabs[0].id) {
          console.error("No active tab found.");
          return;
        }
        chrome.scripting.executeScript({
          target: { tabId: tabs[0].id },
          files: ["content.js"]
        }).catch(err => {
          console.error("Script injection failed:", err);
          setResponseText("Script injection failed: " + err.message);
        });
      });
    });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    console.log("popup received message:", msg);
    if (msg && msg.messageId) {
      createDraftWithReply(msg.messageId);
    } else if (msg && msg.error) {
      setResponseText("Error: " + msg.error);
    }
  });
});

async function createDraftWithReply(messageId) {
  if (isGenerating) {
    setResponseText("Already generating a reply, please wait...");
    return;
  }
  isGenerating = true;

  try {
    setResponseText("Preparing reply...");

    const token = await new Promise((resolve, reject) => {
      chrome.identity.getAuthToken({ interactive: true }, (t) => {
        if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
        resolve(t);
      });
    });

    const msgMetaRes = await safeFetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=metadata`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const msgMeta = await msgMetaRes.json();
    if (!msgMeta || !msgMeta.threadId) throw new Error("Message not found");

    const threadRes = await safeFetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/threads/${msgMeta.threadId}?format=full`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const threadData = await threadRes.json();

    const allMessages = (threadData?.messages || []).map((m) => {
      const h = m.payload.headers || [];
      const from = h.find((x) => x.name === "From")?.value || "";
      const subject = h.find((x) => x.name === "Subject")?.value || "";
      let body = "";

      function extractBody(payload) {
        if (payload.body?.data) {
          body += atob(payload.body.data.replace(/-/g, "+").replace(/_/g, "/"));
        }
        if (payload.parts) {
          payload.parts.forEach(extractBody);
        }
      }
      extractBody(m.payload);

      return {
        id: m.id,
        from,
        subject,
        date: h.find((x) => x.name === "Date")?.value || "",
        body: body.trim(),
      };
    });

    if (!allMessages.length) throw new Error("Thread empty");

    const userName = await getUserFirstName();
    const userPromptInput = document.getElementById("userPrompt");
    const userPrompt = userPromptInput?.value.trim() || "";

    const recentMessages = allMessages.slice(-3);
    const MAX_MSG_LEN = 1000;
    const fullThread = recentMessages
      .map((m, i) => {
        let body = m.body || "";
        if (body.length > MAX_MSG_LEN) {
          body = body.slice(0, MAX_MSG_LEN) + "... [message truncated]";
        }
        return `Message ${i + 1} from ${m.from}:\n${body}`;
      })
      .join("\n\n");

    const lastMsg = allMessages[allMessages.length - 1];
    const from = lastMsg.from;
    const subject = lastMsg.subject;
    const snippet = lastMsg.body.slice(0, 200);

    const prompt = `
You are writing an email reply as ${userName}.

Write a concise, professional response to the following email thread:
- Keep the tone polite and businesslike.
- Begin with an appropriate greeting to the person who sent the last message.
- Respond directly to the most recent message.
- At the end, include a professional closing such as "Best regards," on one line,
  followed by exactly "${userName}" on the next line.

Context:
From: ${from}
Subject: ${subject}

Last message snippet (reply to this): 
${snippet}

Full thread (last 3 messages only): 
${fullThread}

Extra instructions from user:
${userPrompt}

Now write the reply:
`;

    setResponseText("Requesting AI reply from backend...");

    const backendResp = await safeFetch("http://localhost:3000/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });

    if (!backendResp.ok) throw new Error("Backend error: " + backendResp.statusText);
    const { text: replyText } = await backendResp.json();
    console.log("Gemini reply:", replyText);

    insertReplyIntoGmail(replyText);
    setResponseText("Reply inserted into Gmail compose box!");
  } catch (err) {
    console.error("Error:", err);
    setResponseText("Error: " + (err.message || err));
  } finally {
    isGenerating = false;
  }
}

function insertReplyIntoGmail(text) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id) {
      chrome.scripting.executeScript({
        target: { tabId: tabs[0].id },
        func: (text) => {
          const composeBoxes = document.querySelectorAll(
            "div[contenteditable='true'][aria-label='Message Body']"
          );
          let targetBox = null;
          for (const box of composeBoxes) {
            if (box === document.activeElement || box.contains(document.activeElement)) {
              targetBox = box;
              break;
            }
          }
          if (!targetBox && composeBoxes.length) {
            targetBox = composeBoxes[composeBoxes.length - 1];
          }
          if (targetBox) {
            targetBox.innerText = text;
            targetBox.focus();
          } else {
            console.warn("No Gmail compose box found.");
          }
        },
        args: [text],
      });
    }
  });
}
