const form = document.querySelector("#employer-requirements-form");
const skillInput = document.querySelector("#skill-input");
const addSkillButton = document.querySelector("#add-skill-button");
const skillTags = document.querySelector("#skill-tags");
const formMessage = document.querySelector("#form-message");
const description = document.querySelector("#job-description");
const descriptionCount = document.querySelector("#description-count");
const submitButton = document.querySelector("#submit-requirements");
const courseResults = document.querySelector("#course-results");

const skills = [];
const lessonRequestsInFlight = new Map();
let courseRequestInFlight = false;

const fieldIds = {
  companyName: "company-name",
  jobRole: "job-role",
  requiredSkills: "skill-input",
  experienceLevel: "experience-level",
  courseDuration: "course-duration",
  jobDescription: "job-description",
};

class ApiRequestError extends Error {
  constructor(message, category = "request", status = 0) {
    super(message);
    this.name = "ApiRequestError";
    this.category = category;
    this.status = status;
  }
}

function setFieldError(fieldName, message) {
  const field = document.getElementById(fieldIds[fieldName]);
  const error = document.getElementById(`error-${fieldName}`);
  if (field) field.setAttribute("aria-invalid", message ? "true" : "false");
  if (error) error.textContent = message || "";
  if (fieldName === "requiredSkills") skillTags.classList.toggle("has-error", Boolean(message));
}

function clearErrors() {
  Object.keys(fieldIds).forEach((fieldName) => setFieldError(fieldName, ""));
  formMessage.hidden = true;
  formMessage.textContent = "";
  formMessage.className = "form-message";
}

function showFormMessage(message, type, category = "") {
  formMessage.replaceChildren();
  if (category) {
    const label = document.createElement("strong");
    label.className = "error-category";
    label.textContent = `${category.replaceAll("_", " ")}: `;
    formMessage.append(label);
  }
  formMessage.append(document.createTextNode(message));
  formMessage.className = `form-message ${type}`;
  formMessage.hidden = false;
}

async function postJson(url, body, timeoutMilliseconds = 55000) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMilliseconds);

  try {
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (error.name === "AbortError") {
        throw new ApiRequestError("The request timed out. Please retry; the server will report any Gemini timeout details.", "timeout", 0);
      }
      if (error instanceof TypeError) {
        throw new ApiRequestError("The browser could not connect to Flask. Start the app with python app.py and open it at http://127.0.0.1:5000.", "server_connection", 0);
      }
      throw new ApiRequestError(error.message || "The request could not be sent.", "network", 0);
    }

    let result;
    try {
      result = await response.json();
    } catch (error) {
      throw new ApiRequestError("Flask returned a response that was not valid JSON.", "server_response", response.status);
    }

    if (!response.ok) {
      throw new ApiRequestError(
        result.message || `The server returned HTTP ${response.status}.`,
        result.errorCategory || "server_error",
        response.status,
      );
    }
    return result;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function renderSkills() {
  skillTags.replaceChildren();
  skills.forEach((skill, index) => {
    const tag = document.createElement("span");
    tag.className = "skill-tag";
    tag.append(document.createTextNode(skill));

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "remove-skill";
    removeButton.setAttribute("aria-label", `Remove ${skill}`);
    removeButton.textContent = "×";
    removeButton.addEventListener("click", () => {
      skills.splice(index, 1);
      renderSkills();
      if (skills.length > 0) setFieldError("requiredSkills", "");
    });

    tag.append(removeButton);
    skillTags.append(tag);
  });
}

function addSkill() {
  const value = skillInput.value.trim();
  if (!value) {
    skillInput.focus();
    return;
  }
  if (skills.some((skill) => skill.toLocaleLowerCase() === value.toLocaleLowerCase())) {
    setFieldError("requiredSkills", "That skill has already been added.");
    skillInput.focus();
    return;
  }
  if (skills.length >= 20) {
    setFieldError("requiredSkills", "You can add up to 20 skills.");
    skillInput.focus();
    return;
  }

  skills.push(value);
  skillInput.value = "";
  renderSkills();
  setFieldError("requiredSkills", "");
  skillInput.focus();
}

function makeElement(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function appendList(parent, items, className = "course-list") {
  const list = makeElement("ul", className);
  items.forEach((item) => list.append(makeElement("li", "", item)));
  parent.append(list);
}

function requirementsForRequest() {
  const formData = new FormData(form);
  return {
    companyName: formData.get("companyName").trim(),
    jobRole: formData.get("jobRole").trim(),
    requiredSkills: [...skills],
    experienceLevel: formData.get("experienceLevel"),
    courseDuration: formData.get("courseDuration"),
    jobDescription: formData.get("jobDescription").trim(),
  };
}

function validateForm() {
  const formData = new FormData(form);
  const requiredFields = ["companyName", "jobRole", "experienceLevel", "courseDuration", "jobDescription"];
  let invalid = false;

  requiredFields.forEach((fieldName) => {
    if (!String(formData.get(fieldName) || "").trim()) {
      setFieldError(fieldName, "This field is required.");
      invalid = true;
    }
  });
  if (skills.length === 0) {
    setFieldError("requiredSkills", "Add at least one required skill.");
    invalid = true;
  }

  if (invalid) {
    showFormMessage("Please complete the required fields before generating a course.", "error", "validation");
    const firstInvalidField = form.querySelector('[aria-invalid="true"]');
    if (firstInvalidField) firstInvalidField.focus();
  }
  return !invalid;
}

function hashText(text) {
  // FNV-1a makes a compact local cache key without sending anything to a service.
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

function lessonCacheKey(requirements, module, moduleIndex) {
  return `veridion:lesson:v1:${hashText(JSON.stringify({ requirements, module, moduleIndex }))}`;
}

function readCachedLesson(key) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : null;
  } catch (error) {
    return null;
  }
}

function cacheLesson(key, lesson) {
  try {
    localStorage.setItem(key, JSON.stringify(lesson));
  } catch (error) {
    // A full or disabled browser store should not stop the lesson from displaying.
  }
}

function renderDetailedLesson(panel, lesson) {
  panel.replaceChildren();
  panel.classList.remove("lesson-panel-error");
  panel.append(makeElement("h4", "lesson-subheading", "Detailed lesson"));
  panel.append(makeElement("p", "lesson-text", lesson.lessonContent));
  panel.append(makeElement("h4", "lesson-subheading", "Guided steps"));
  appendList(panel, lesson.guidedSteps, "lesson-steps");
  panel.append(makeElement("h4", "lesson-subheading", "Complete the practical exercise"));
  panel.append(makeElement("p", "lesson-text", lesson.exerciseInstructions));
  panel.append(makeElement("h4", "lesson-subheading", "Evidence to submit"));
  panel.append(makeElement("p", "lesson-text", lesson.evidenceToSubmit));
  if (lesson.safetyReminder) {
    panel.append(makeElement("p", "lesson-safety-note", lesson.safetyReminder));
  }
  panel.dataset.loaded = "true";
}

function renderLessonFailure(panel, error, retry) {
  panel.replaceChildren();
  panel.classList.add("lesson-panel-error");
  panel.append(makeElement("p", "", error.message));
  if (error.category) panel.append(makeElement("small", "", `Category: ${error.category.replaceAll("_", " ")}`));
  const retryButton = makeElement("button", "lesson-retry", "Retry lesson");
  retryButton.type = "button";
  retryButton.addEventListener("click", retry);
  panel.append(retryButton);
}

async function loadDetailedLesson(details, requirements, course, module, moduleIndex) {
  if (!details.open) return;
  const panel = details.querySelector(".detailed-lesson");
  if (panel.dataset.loaded === "true") return;

  const cacheKey = lessonCacheKey(requirements, module, moduleIndex);
  const cachedLesson = readCachedLesson(cacheKey);
  if (cachedLesson) {
    renderDetailedLesson(panel, cachedLesson);
    return;
  }

  const existingRequest = lessonRequestsInFlight.get(cacheKey);
  if (existingRequest) {
    panel.replaceChildren(makeElement("p", "lesson-loading", "Preparing the detailed lesson..."));
    try {
      const lesson = await existingRequest;
      renderDetailedLesson(panel, lesson);
    } catch (error) {
      renderLessonFailure(panel, error, () => loadDetailedLesson(details, requirements, course, module, moduleIndex));
    }
    return;
  }

  panel.classList.remove("lesson-panel-error");
  panel.replaceChildren(makeElement("p", "lesson-loading", "Preparing the detailed lesson..."));

  const requestPromise = (async () => {
    const result = await postJson("/api/course-lesson", {
      requirements,
      course: { courseTitle: course.courseTitle },
      module,
    });
    cacheLesson(cacheKey, result.lesson);
    return result.lesson;
  })();

  lessonRequestsInFlight.set(cacheKey, requestPromise);
  try {
    const lesson = await requestPromise;
    renderDetailedLesson(panel, lesson);
  } catch (error) {
    renderLessonFailure(panel, error, () => loadDetailedLesson(details, requirements, course, module, moduleIndex));
  } finally {
    lessonRequestsInFlight.delete(cacheKey);
  }
}

function renderCourse(course, requirements) {
  courseResults.replaceChildren();
  const header = makeElement("header", "generated-course-header");
  header.append(makeElement("span", "course-eyebrow", "PERSONALIZED COURSE OUTLINE"));
  header.append(makeElement("h2", "", course.courseTitle));
  header.append(makeElement(
    "p",
    "course-meta",
    `${course.targetJobRole} · ${course.experienceLevel} · ${course.courseDuration}`,
  ));
  header.append(makeElement("p", "course-overview", course.courseOverview));
  header.append(makeElement("h3", "course-small-heading", "Skills covered"));
  const skillList = makeElement("div", "course-skill-chips");
  course.requiredSkillsCovered.forEach((skill) => skillList.append(makeElement("span", "course-skill-chip", skill)));
  header.append(skillList);
  courseResults.append(header);

  const modulesSection = makeElement("section", "generated-modules");
  modulesSection.append(makeElement("h3", "course-section-title", "Three focused learning modules"));
  modulesSection.append(makeElement("p", "course-section-intro", "The outline is ready. Open a module to generate its detailed lesson."));

  course.modules.forEach((module, index) => {
    const details = makeElement("details", "module-accordion");
    const summary = makeElement("summary", "module-summary");
    summary.append(makeElement("span", "module-number", String(index + 1).padStart(2, "0")));
    summary.append(makeElement("span", "module-summary-title", module.title));
    summary.append(makeElement("span", "module-time", module.timeAllocation));
    details.append(summary);

    const body = makeElement("div", "module-content");
    body.append(makeElement("p", "module-description", module.description));
    body.append(makeElement("h4", "course-small-heading", "Learning objectives"));
    appendList(body, module.learningObjectives, "course-list");
    const exercise = makeElement("div", "exercise-callout");
    exercise.append(makeElement("span", "course-eyebrow", "PRACTICAL EXERCISE"));
    exercise.append(makeElement("p", "", module.practicalExercise));
    body.append(exercise);
    body.append(makeElement("div", "detailed-lesson"));
    details.append(body);

    details.addEventListener("toggle", () => {
      if (details.open) loadDetailedLesson(details, requirements, course, module, index);
    });
    modulesSection.append(details);
  });
  courseResults.append(modulesSection);

  const project = makeElement("section", "final-project-card");
  project.append(makeElement("span", "course-eyebrow", "FINAL PRACTICAL PROJECT"));
  project.append(makeElement("h3", "", course.finalProject.title));
  project.append(makeElement("p", "project-description", course.finalProject.description));
  const projectColumns = makeElement("div", "project-columns");
  const deliverables = makeElement("div", "project-column");
  deliverables.append(makeElement("h4", "course-small-heading", "What to submit"));
  appendList(deliverables, course.finalProject.deliverables, "course-list");
  const criteria = makeElement("div", "project-column");
  criteria.append(makeElement("h4", "course-small-heading", "Assessment criteria"));
  appendList(criteria, course.finalProject.assessmentCriteria, "course-list");
  projectColumns.append(deliverables, criteria);
  project.append(projectColumns);
  courseResults.append(project);

  const assessment = makeElement("section", "assessment-section");
  assessment.append(makeElement("h3", "course-section-title", "Five assessment questions"));
  course.assessmentQuestions.forEach((item, index) => {
    const details = makeElement("details", "assessment-accordion");
    const summary = makeElement("summary", "assessment-summary");
    summary.append(makeElement("span", "assessment-number", `Q${index + 1}`));
    summary.append(makeElement("span", "", item.question));
    details.append(summary);
    const answer = makeElement("div", "assessment-answer");
    answer.append(makeElement("strong", "", "Answer"));
    answer.append(makeElement("p", "", item.answer));
    answer.append(makeElement("strong", "", "Explanation"));
    answer.append(makeElement("p", "", item.explanation));
    details.append(answer);
    assessment.append(details);
  });
  courseResults.append(assessment);
  courseResults.hidden = false;
}

addSkillButton.addEventListener("click", addSkill);
skillInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    addSkill();
  }
});

description.addEventListener("input", () => {
  descriptionCount.textContent = `${description.value.length} / 5000`;
});

form.querySelectorAll("input[name], select[name], textarea[name]").forEach((field) => {
  field.addEventListener("input", () => {
    field.setAttribute("aria-invalid", "false");
    const error = document.getElementById(`error-${field.name}`);
    if (error) error.textContent = "";
  });
  field.addEventListener("change", () => {
    field.setAttribute("aria-invalid", "false");
    const error = document.getElementById(`error-${field.name}`);
    if (error) error.textContent = "";
  });
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (courseRequestInFlight) return;
  clearErrors();
  if (!validateForm()) return;

  courseRequestInFlight = true;
  submitButton.disabled = true;
  submitButton.querySelector(".button-label").textContent = "Creating course outline...";
  courseResults.hidden = true;
  courseResults.replaceChildren();
  showFormMessage("Gemini is creating a concise three-module outline. Detailed lessons load when opened.", "loading");

  try {
    const requirements = requirementsForRequest();
    const result = await postJson("/api/generate-course", requirements);
    renderCourse(result.course, requirements);
    showFormMessage("Your course outline is ready. Open any module for its detailed lesson.", "success");
    courseResults.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    showFormMessage(error.message || "Course generation failed. Please retry.", "error", error.category || "request");
  } finally {
    courseRequestInFlight = false;
    submitButton.disabled = false;
    submitButton.querySelector(".button-label").textContent = "Generate Learning Path";
  }
});
