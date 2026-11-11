// The test process imports the Worker's route declarations to enumerate the routes it serves; the Durable Object base
// class those modules extend exists only under workerd, where the stack runs them. Nothing here is instantiated.
export class DurableObject {}
