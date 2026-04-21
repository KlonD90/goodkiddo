const nav = document.getElementById("nav");
window.addEventListener("scroll", () => {
    nav.classList.toggle("scrolled", window.scrollY > 20);
});

const reveals = document.querySelectorAll(".reveal");
const observer = new IntersectionObserver(
    (entries) => {
        entries.forEach((entry) => {
            if (entry.isIntersecting) {
                entry.target.classList.add("visible");
            }
        });
    },
    { threshold: 0.15, rootMargin: "0px 0px -40px 0px" },
);
reveals.forEach((el) => observer.observe(el));

function handleAsk() {
    const input = document.getElementById("askInput");
    const response = document.getElementById("askResponse");
    const title = document.getElementById("askResponseTitle");
    const text = document.getElementById("askResponseText");
    const val = input.value.trim();

    if (!val) {
        input.focus();
        return;
    }

    response.className = "ask-response visible pending";
    title.textContent = "Got it!";
    text.textContent =
        "We've noted your use case. If this isn't already supported, it's now on our radar. Try opening Good Kiddo on Telegram to test it — you might be surprised.";

    const lower = val.toLowerCase();
    if (
        lower.includes("invoice") ||
        lower.includes("reconcil") ||
        lower.includes("accounting")
    ) {
        response.className = "ask-response visible";
        title.textContent = "Yes, Good Kiddo can help with that";
        text.textContent =
            "Good Kiddo already works with invoices, financial documents, and reconciliation workflows. Open Telegram and give it a try — describe what you need in plain language.";
    } else if (
        lower.includes("email") ||
        lower.includes("draft") ||
        lower.includes("write")
    ) {
        response.className = "ask-response visible";
        title.textContent = "Absolutely — that's a core feature";
        text.textContent =
            "Drafting emails in your tone is one of the things Good Kiddo does best. Just describe who you're writing to and what you want to say.";
    } else if (
        lower.includes("spreadsheet") ||
        lower.includes("excel") ||
        lower.includes("data")
    ) {
        response.className = "ask-response visible";
        title.textContent = "Yes, Good Kiddo handles spreadsheets";
        text.textContent =
            "You can share spreadsheets and ask Good Kiddo to analyze, summarize, or extract data. It understands financial formats and can explain complex numbers in plain language.";
    }
}

document
    .getElementById("askInput")
    .addEventListener("keydown", function (e) {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleAsk();
        }
    });