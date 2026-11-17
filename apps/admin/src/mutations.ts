/** Shared client feedback for backoffice writes, embedded into each route module. */
export const ADMIN_MUTATION_SCRIPT = `
    async function runAdminMutation(button, statusElement, path, body, busyLabel) {
      if (button?.disabled) return;
      const idleLabel = button?.textContent;
      if (button) {
        button.disabled = true;
        button.textContent = busyLabel;
        button.setAttribute("aria-busy", "true");
      }
      if (statusElement) {
        statusElement.textContent = busyLabel;
        statusElement.style.color = "var(--text-secondary)";
      }
      try {
        const response = await fetch(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await response.json();
        if (!response.ok || data.ok === false) {
          const hint = response.status === 401
            ? " Sign in and try again."
            : response.status === 403
              ? " Switch to an account with permission for this action."
              : " Check the values and try again.";
          throw new Error("HTTP " + response.status + ": " + (data.error || "Unable to save changes.") + hint);
        }
        window.location.reload();
      } catch (error) {
        if (statusElement) {
          statusElement.style.color = "var(--accent-amber)";
          statusElement.textContent = error instanceof TypeError
            ? "Connection failed. Check your connection and try again."
            : error instanceof Error ? error.message : "Unable to save changes. Try again.";
          statusElement.setAttribute("tabindex", "-1");
          statusElement.focus();
        }
      } finally {
        if (button) {
          button.disabled = false;
          button.textContent = idleLabel;
          button.removeAttribute("aria-busy");
        }
      }
    }
`;
