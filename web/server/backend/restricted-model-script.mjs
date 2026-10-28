import {parse} from "@babel/parser";

// Deliberately NOT a JavaScript runtime or a Node vm. Only a small, audited
// expression language is interpreted. No host globals, prototypes, eval,
// arbitrary callable values or access to credentials are exposed.
const problem=(code)=>Object.assign(Error(code),{code,statusCode:422,confirmedNotAccepted:true});
const forbidden=new Set(["__proto__","prototype","constructor"]);
const maxScriptBytes=16_384;
const safeKey=key=>{
 const k=String(key);
 if(forbidden.has(k))throw problem("model_script_property_forbidden");
 return k;
};
export function parseRestrictedModelScript(script){
 if(typeof script!=="string"||!script.trim()||
   Buffer.byteLength(script,"utf8")>maxScriptBytes)
  throw problem("model_script_invalid");
 let ast;
 try{ast=parse(script,{sourceType:"script",allowReturnOutsideFunction:true,
  allowAwaitOutsideFunction:true})}
 catch{throw problem("model_script_syntax_invalid")}
 if(ast.program.body.length>32)throw problem("model_script_too_complex");
 let count=0,requestCount=0;
 const visit=(node,depth=0)=>{
  if(!node||depth>30||++count>650)throw problem("model_script_too_complex");
  switch(node.type){
   case "File":return visit(node.program,depth+1);
   case "Program":return node.body.forEach(n=>visit(n,depth+1));
   case "VariableDeclaration":
    if(node.kind!=="const"||node.declarations.length>12)throw problem("model_script_unsupported");
    return node.declarations.forEach(n=>visit(n,depth+1));
   case "VariableDeclarator":
    if(node.id.type!=="Identifier"||!node.init)throw problem("model_script_unsupported");
    return visit(node.init,depth+1);
   case "ReturnStatement":case "ExpressionStatement":return visit(node.argument??node.expression,depth+1);
   case "AwaitExpression":return visit(node.argument,depth+1);
   case "CallExpression":{
    if(node.optional||node.callee.type!=="MemberExpression"||
       node.callee.computed||node.callee.object.type!=="Identifier"||
       node.callee.object.name!=="http"||node.callee.property.type!=="Identifier"||
       !["post","get","delete","multipart"].includes(node.callee.property.name))
     throw problem("model_script_call_forbidden");
    // At most one external request per script; prevents accidental double billing.
    if(++requestCount>1)throw problem("model_script_multiple_requests_forbidden");
    if(node.arguments.length<1||node.arguments.length>2||
       node.arguments.some(a=>a.type==="SpreadElement"))
     throw problem("model_script_unsupported");
    return node.arguments.forEach(n=>visit(n,depth+1));
   }
   case "Identifier":
    if(forbidden.has(node.name))throw problem("model_script_property_forbidden");
    return;
   case "StringLiteral":case "NumericLiteral":case "BooleanLiteral":case "NullLiteral":return;
   case "ObjectExpression":return node.properties.forEach(prop=>{
    if(prop.type!=="ObjectProperty"||prop.computed||
       !(prop.key.type==="Identifier"||prop.key.type==="StringLiteral"))
     throw problem("model_script_unsupported");
    safeKey(prop.key.name??prop.key.value);visit(prop.value,depth+1);
   });
   case "ArrayExpression":return node.elements.forEach(n=>{
    if(!n||n.type==="SpreadElement")throw problem("model_script_unsupported");
    visit(n,depth+1);
   });
   case "MemberExpression":case "OptionalMemberExpression":
    visit(node.object,depth+1);
    if(node.computed)visit(node.property,depth+1);
    else if(node.property.type!=="Identifier")throw problem("model_script_unsupported");
    else safeKey(node.property.name);
    return;
   case "LogicalExpression":
    if(!["||","??","&&"].includes(node.operator))throw problem("model_script_unsupported");
    visit(node.left,depth+1);return visit(node.right,depth+1);
   case "ConditionalExpression":
    [node.test,node.consequent,node.alternate].forEach(n=>visit(n,depth+1));return;
   case "BinaryExpression":
    if(!["===","!==","==","!=","+","-"].includes(node.operator))
     throw problem("model_script_unsupported");
    visit(node.left,depth+1);return visit(node.right,depth+1);
   case "UnaryExpression":
    if(!["!","-","+"].includes(node.operator))throw problem("model_script_unsupported");
    return visit(node.argument,depth+1);
   case "TemplateLiteral":
    node.expressions.forEach(n=>visit(n,depth+1));return;
   default:throw problem("model_script_unsupported");
  }
 };
 visit(ast);
 if(requestCount!==1||!ast.program.body.some(n=>n.type==="ReturnStatement"))
  throw problem("model_script_return_and_request_required");
 return ast.program.body;
}
export async function runRestrictedModelScript({script,model,prompt,messages,params={},remoteTaskId,http}){
 const statements=parseRestrictedModelScript(script);
 const env=Object.assign(Object.create(null),{model,prompt,messages,params,
  ...(remoteTaskId!==undefined?{remoteTaskId}:{} )});
 let steps=0;
 async function evaluate(n){
  if(++steps>600)throw problem("model_script_too_complex");
  switch(n.type){
   case "Identifier":
    if(!Object.hasOwn(env,n.name))throw problem("model_script_unknown_identifier");
    return env[n.name];
   case "StringLiteral":case "NumericLiteral":case "BooleanLiteral":return n.value;
   case "NullLiteral":return null;
   case "AwaitExpression":return evaluate(n.argument);
   case "CallExpression":{
    const method=n.callee.property.name;
    const args=[];for(const item of n.arguments)args.push(await evaluate(item));
    if(typeof args[0]!=="string"||args[0].length>512||
       !args[0].startsWith("/")||args[0].startsWith("//")||
       args[0].includes("\\")||args[0].includes("?")||args[0].includes("#")||
       args[0].split("/").some(part=>part===".."||part===".")||
       /%(?:2f|5c|2e)/i.test(args[0]))
     throw problem("model_script_endpoint_invalid");
    if(["post","multipart"].includes(method)&&(args[1]===undefined||!args[1]||
       typeof args[1]!=="object"||Array.isArray(args[1])))
     throw problem("model_script_body_invalid");
    return http(method,args[0],args[1]);
   }
   case "MemberExpression":case "OptionalMemberExpression":{
    const obj=await evaluate(n.object);
    if(obj===null||obj===undefined){
     if(n.optional)return undefined;
     throw problem("model_script_property_missing");
    }
    const key=safeKey(n.computed?await evaluate(n.property):n.property.name);
    if((typeof obj!=="object"||obj===null)&&typeof obj!=="string")
     throw problem("model_script_property_forbidden");
    if(key==="length"&&(Array.isArray(obj)||typeof obj==="string"))return obj.length;
    if(!Object.hasOwn(obj,key))return undefined;
    const value=obj[key];
    if(typeof value==="function")throw problem("model_script_property_forbidden");
    return value;
   }
   case "ObjectExpression":{
    const value=Object.create(null);
    for(const item of n.properties)value[safeKey(item.key.name??item.key.value)]=await evaluate(item.value);
    return value;
   }
   case "ArrayExpression":{
    const value=[];for(const item of n.elements)value.push(await evaluate(item));return value;
   }
   case "LogicalExpression":{
    const a=await evaluate(n.left);
    if(n.operator==="||")return a? a:evaluate(n.right);
    if(n.operator==="??")return a??await evaluate(n.right);
    return a?evaluate(n.right):a;
   }
   case "ConditionalExpression":return await evaluate(n.test)?evaluate(n.consequent):evaluate(n.alternate);
   case "BinaryExpression":{
    const a=await evaluate(n.left),b=await evaluate(n.right);
    switch(n.operator){
     case "===":return a===b;case "!==":return a!==b;
     case "==":return a==b;case "!=":return a!=b;
     case "+":return a+b;case "-":return a-b;
    }
   }
   case "UnaryExpression":{
    const a=await evaluate(n.argument);
    return n.operator==="!"?!a:n.operator==="-"?-a:+a;
   }
   case "TemplateLiteral":{
    let out=n.quasis[0].value.cooked??"";
    for(let i=0;i<n.expressions.length;i++)
     out+=String(await evaluate(n.expressions[i]))+(n.quasis[i+1].value.cooked??"");
    return out;
   }
   default:throw problem("model_script_unsupported");
  }
 }
 for(const statement of statements){
  if(statement.type==="VariableDeclaration"){
   for(const item of statement.declarations){
    if(Object.hasOwn(env,item.id.name))throw problem("model_script_duplicate_binding");
    env[item.id.name]=await evaluate(item.init);
   }
  }else if(statement.type==="ReturnStatement")return evaluate(statement.argument);
  else await evaluate(statement.expression);
 }
 throw problem("model_script_return_required");
}
