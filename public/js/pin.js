/**
 * LocalShare PIN gate.
 * WHY a separate page: with a PIN configured the server serves this file for
 * every HTML route until the session cookie exists, so the app markup is never
 * handed to unauthenticated clients.
 */

const form = document.getElementById("pin-form");
const input = document.getElementById("pin-input");
const error = document.getElementById("pin-error");
const submit = document.getElementById("pin-submit");

applyStoredTheme();
input.focus();

let countdownTimer = null;

function showError(message) {
  error.textContent = message;
  error.style.display = "block";
  form.classList.remove("shaking");
  void form.offsetWidth; // restart the shake animation
  form.classList.add("shaking");
}

function startLockout(ms) {
  clearInterval(countdownTimer);
  input.disabled = true;
  submit.disabled = true;
  let remaining = Math.ceil(ms / 1000);
  const tick = () => {
    if (remaining <= 0) {
      clearInterval(countdownTimer);
      input.disabled = false;
      submit.disabled = false;
      error.style.display = "none";
      input.focus();
      return;
    }
    error.textContent = `Too many failed attempts. Try again in ${remaining}s.`;
    error.style.display = "block";
    remaining -= 1;
  };
  tick();
  countdownTimer = setInterval(tick, 1000);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const pin = input.value.trim();
  if (!pin) return;

  submit.classList.add("is-loading");
  try {
    const res = await fetch("/api/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin }),
    });
    const body = await res.json().catch(() => ({}));

    if (res.ok && body.success) {
      // Land on the real app now that the cookie is set
      window.location.replace("/");
      return;
    }

    if (body.error?.code === "AUTH_LOCKED") {
      startLockout(body.error.lockoutDuration || 30000);
      return;
    }

    showError("Incorrect PIN. Please try again.");
    input.value = "";
    input.focus();
  } catch {
    showError("Could not reach the server. Try again.");
  } finally {
    submit.classList.remove("is-loading");
  }
});

function applyStoredTheme() {
  const theme = localStorage.getItem("localshare:theme") || "system";
  document.documentElement.dataset.theme = theme;
}
