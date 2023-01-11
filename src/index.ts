import {authenticateFrom, GoogleTaskInsert, TaskApi} from "./googleHelper";

export interface Env {
  KV: KVNamespace;
  mapping: KVNamespace;

  CLIENT_ID: string;
  CLIENT_SECRET: string;
}

interface TodoistDue {
  date: string
  is_recurring: boolean // TODO can't really deal with recurring tasks rn
}

interface TodoistTask {
  checked: boolean
  content: string
  description: string
  due: TodoistDue|null
  completed_at: string|null
  id: string
  is_deleted: 0|1;
}

interface WebhookEvent {
  event_name: string
  user_id: string
  event_data: TodoistTask
}

function translateTask(model: TodoistTask): GoogleTaskInsert {
  // TODO: sub tasks
  const result: GoogleTaskInsert = {
    title : model.content,
    notes : model.description,
  };
  if (model.due != null) {
    // Note: We are unable to enforce time of day here.
    result.due = new Date(model.due.date).toISOString();
    result.status = "needsAction";
  }
  if (model.checked) {
    result.completed = new Date(model.completed_at || new Date()).toISOString();
    result.status = "completed";
  }
  if (model.is_deleted == 1)
    result.deleted = true;
  return result;
}

interface TaskContext {
  service: TaskApi;
  env: Env;
}

const TOMB_STONE = "__DELETED"

async function createNewTask(model: TodoistTask, context: TaskContext) {
  const tsk = await context.service.insertTask(translateTask(model));
  console.debug("created task:", JSON.stringify(tsk));
  await putMapping(model.id, tsk.id, context)
  console.debug("put mapping info");
}

async function updateTask(model: TodoistTask, googleId: string,
                          context: TaskContext) {
  const gtsk = await context.service.updateTask(googleId, translateTask(model))
  console.debug("updated as: ", gtsk);
}

async function deleteTask(googleId: string, todoistId: string,
                          context: TaskContext) {
  // TODO handle task does not exist (404?)
  await context.service.deleteTask(googleId);
  console.debug("deleted from google");
  await markMappingForDeletion(todoistId, context);
  console.debug("deleted mapping");
}

async function markMappingForDeletion(todoistId: string, context: TaskContext) {
  const HOUR = 60 * 60;
  await context.env.mapping.put(todoistId, TOMB_STONE, {expirationTtl : HOUR});
  console.debug("Tomb stone marked for " + todoistId);
}

async function putMapping(todoistId: string, googleId: string,
                          context: TaskContext) {
  await context.env.mapping.put(todoistId, googleId);
}

async function findMapping(todoistId: string,
                           context: TaskContext): Promise<string|null> {
  const mapping = await context.env.mapping.get(todoistId);
  if (mapping == null) {
    console.debug("mapping does not exist in our system");
    return null;
  }
  return mapping;
}

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const event: WebhookEvent = await request.json();
  const auth = await authenticateFrom(event.user_id, env);
  const response = new Response("", {status : 200});

  if (auth == null) {
    console.log(`todoist user: ${event.user_id} auth not found in our DB`);
    return response;
  }

  console.debug(`found auth info for ${event.user_id}`);
  // TODO: lookup listId
  const service = new TaskApi("MDQxNjYxMjg3ODk5NzMwMTM2NzQ6MDow", auth);
  console.debug("Event:", event);

  const context: TaskContext = {service : service, env : env};
  const model = event.event_data;
  const todoistId = model.id;

  if (event.event_name == "item:added") {
    console.log("creating new task");
    await createNewTask(model, context)
    return response;
  }

  const googleId = await findMapping(todoistId, context);
  console.debug(`task id translation: ${todoistId} -> ${googleId}`);
  if (googleId == TOMB_STONE) {
    // This means the events came out of order, and the original is deleted.
    console.log("event tomb-stoned, ignored");
    return response;
  }

  if (event.event_name == "item:deleted") {
    if (googleId) {
      console.log("task in our sys, deleting task");
      await deleteTask(googleId, todoistId, context);
    } else {
      console.log("cannot find mapped task, ignored");
    }
    return response;
  }

  if (googleId == null) {
    console.log("cannot find given task, creating a new one");
    await createNewTask(model, context)
    return response;
  }

  console.log("updating task");
  await updateTask(model, googleId, context);

  return response;
}

function isWebhookRoute(request: Request): boolean {
  const ctype = request.headers.get("content-type") || "";
  const url = new URL(request.url);
  // TODO: check x-app-id?
  return ctype === "application/json" && request.method == "POST" &&
         url.pathname.startsWith("/todoist-webhook/");
}

export default {
  async fetch(request: Request, env: Env, _: ExecutionContext):
      Promise<Response> {
        console.log("incoming request", request.method, request.url);
        if (isWebhookRoute(request))
          return handleWebhook(request, env);
        else
          return new Response(
              'Not found',
              {status : 404, headers : {'Content-Type' : 'plain'}});
      },
};
