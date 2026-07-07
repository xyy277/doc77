import React, { useState } from 'react';
import { 
  Folder, FileText, FileCode, FileImage, FileDown, 
  ChevronRight, ChevronDown, Edit, ExternalLink, 
  MessageSquare, ListTodo, Search, Settings, 
  CheckCircle, XCircle, AlertTriangle, Sparkles,
  Bot, User, Send, RefreshCw
} from 'lucide-react';

// --- Mock Data ---
const mockFileTree = [
  {
    name: '技术文档', type: 'folder', isOpen: true, children: [
      { name: 'API设计.md', type: 'file', icon: FileText, size: '24 KB' },
      { name: '架构图.mermaid', type: 'file', icon: FileCode, size: '12 KB' },
      { name: '废弃接口.md', type: 'file', icon: FileText, size: '8 KB' },
    ]
  },
  {
    name: '资源文件', type: 'folder', isOpen: false, children: [
      { name: 'logo.png', type: 'file', icon: FileImage, size: '1.2 MB' },
      { name: '演示视频_超大.mp4', type: 'file', icon: FileDown, size: '120 MB' },
    ]
  },
  { name: 'README.md', type: 'file', icon: FileText, size: '5 KB' },
  { name: '.doc77ignore', type: 'file', icon: FileCode, size: '1 KB' },
];

const mockChat = [
  { role: 'user', content: '帮我整理技术文档文件夹，清理掉没用的文件。' },
  { role: 'ai', content: '好的，我已经分析了 `技术文档` 目录。发现 `废弃接口.md` 可能是过时的文件。\n\n我为您生成了以下操作建议：\n1. 创建 `archive` 归档文件夹\n2. 将 `废弃接口.md` 移动到归档中\n\n操作已加入审批队列，请在“审批流”面板中确认执行。' }
];

const mockTasks = [
  { id: 'task_001', type: 'create_folder', path: '技术文档/archive', status: 'pending' },
  { id: 'task_002', type: 'move_file', source: '技术文档/废弃接口.md', target: '技术文档/archive/废弃接口.md', status: 'pending' },
  { id: 'task_003', type: 'delete_file', path: '资源文件/演示视频_超大.mp4', status: 'pending', warning: '超大文件(120MB)，操作无法回滚' }
];

export default function Doc77App() {
  const [activeTab, setActiveTab] = useState('chat'); // 'chat' or 'queue'
  const [tasks, setTasks] = useState(mockTasks);
  const [chatMessage, setChatMessage] = useState('');

  const handleApprove = (id) => {
    setTasks(tasks.map(t => t.id === id ? { ...t, status: 'executed' } : t));
  };

  const handleReject = (id) => {
    setTasks(tasks.map(t => t.id === id ? { ...t, status: 'rejected' } : t));
  };

  return (
    <div className="flex h-screen w-full bg-slate-50 text-slate-800 font-sans overflow-hidden">
      
      {/* 左侧栏：项目与文件树 */}
      <div className="w-64 bg-slate-900 text-slate-300 flex flex-col border-r border-slate-800">
        <div className="p-4 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2 text-white font-bold text-lg">
            <span className="bg-blue-600 text-white p-1 rounded"><Folder size={18} /></span>
            Doc77
          </div>
          <button className="text-slate-400 hover:text-white transition"><Settings size={18} /></button>
        </div>
        
        <div className="p-3">
          <div className="bg-slate-800 rounded px-3 py-2 text-sm flex items-center justify-between text-slate-200 cursor-pointer border border-slate-700">
            <span className="font-medium truncate">💼 客户A项目</span>
            <ChevronDown size={14} />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto py-2">
          <div className="px-4 pb-2 text-xs font-semibold text-slate-500 uppercase tracking-wider flex justify-between items-center">
            目录树
            <button className="hover:text-slate-300" title="刷新缓存"><RefreshCw size={12} /></button>
          </div>
          <div className="px-2 space-y-0.5 text-sm">
            {mockFileTree.map((item, idx) => (
              <FileTreeNode key={idx} node={item} depth={0} />
            ))}
          </div>
        </div>
        
        <div className="p-3 border-t border-slate-800 text-xs text-slate-500 flex justify-between">
          <span>v2.5.0-beta</span>
          <span className="flex items-center gap-1 text-emerald-500"><div className="w-2 h-2 rounded-full bg-emerald-500"></div> 服务正常</span>
        </div>
      </div>

      {/* 中间栏：预览引擎 */}
      <div className="flex-1 flex flex-col bg-white">
        {/* 顶部工具栏 */}
        <div className="h-14 border-b border-slate-200 flex items-center justify-between px-4 bg-white shadow-sm z-10">
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <span className="hover:text-slate-800 cursor-pointer">客户A项目</span>
            <ChevronRight size={14} />
            <span className="hover:text-slate-800 cursor-pointer">技术文档</span>
            <ChevronRight size={14} />
            <span className="font-medium text-slate-800 flex items-center gap-1">
              <FileText size={14} className="text-blue-500" />
              API设计.md
            </span>
          </div>
          
          <div className="flex items-center gap-3">
            <button className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-purple-600 bg-purple-50 hover:bg-purple-100 rounded-md transition border border-purple-100">
              <Sparkles size={14} />
              AI 总结
            </button>
            <div className="h-4 w-px bg-slate-300"></div>
            <button className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-md transition" title="在VS Code中打开">
              <Edit size={14} />
              在编辑器中打开
            </button>
            <button className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-md transition" title="在系统文件管理器中显示">
              <ExternalLink size={14} />
              在文件夹中显示
            </button>
          </div>
        </div>

        {/* 文档预览区 */}
        <div className="flex-1 overflow-y-auto p-10 bg-slate-50">
          <div className="max-w-4xl mx-auto bg-white p-12 rounded-xl shadow-sm border border-slate-200">
            <h1 className="text-3xl font-bold mb-6 text-slate-900 border-b pb-4">API 接口设计规范 (v2.0)</h1>
            <div className="prose prose-slate max-w-none">
              <p className="text-slate-600 mb-4">本文档定义了客户A项目中核心微服务的 API 交互规范。所有新接口必须遵循此标准。</p>
              
              <h2 className="text-xl font-semibold mt-8 mb-4 text-slate-800">1. 全局约定</h2>
              <ul className="list-disc pl-5 space-y-2 text-slate-700 mb-6">
                <li>基于 HTTP/1.1 与 HTTP/2 协议</li>
                <li>数据传输格式统一为 <code>application/json</code></li>
                <li>字符编码统一为 <code>UTF-8</code></li>
              </ul>

              <h2 className="text-xl font-semibold mt-8 mb-4 text-slate-800">2. 状态码规范</h2>
              <table className="min-w-full border-collapse border border-slate-300 text-sm mb-6">
                <thead>
                  <tr className="bg-slate-100">
                    <th className="border border-slate-300 px-4 py-2 text-left">HTTP 状态码</th>
                    <th className="border border-slate-300 px-4 py-2 text-left">业务状态码</th>
                    <th className="border border-slate-300 px-4 py-2 text-left">说明</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="border border-slate-300 px-4 py-2 text-green-600 font-mono">200</td>
                    <td className="border border-slate-300 px-4 py-2 font-mono">0</td>
                    <td className="border border-slate-300 px-4 py-2">请求成功并返回预期数据</td>
                  </tr>
                  <tr>
                    <td className="border border-slate-300 px-4 py-2 text-red-600 font-mono">400</td>
                    <td className="border border-slate-300 px-4 py-2 font-mono">40001</td>
                    <td className="border border-slate-300 px-4 py-2">参数校验失败，需检查入参</td>
                  </tr>
                </tbody>
              </table>
              
              <div className="bg-blue-50 border-l-4 border-blue-500 p-4 rounded-r my-6">
                <p className="text-sm text-blue-800 m-0 flex items-start gap-2">
                  <Sparkles size={16} className="mt-0.5 shrink-0" />
                  <span><strong>AI 洞察：</strong> 此文档与上周更新的《架构图.mermaid》部分字段映射存在轻微脱节，建议结合查阅。</span>
                </p>
              </div>
            </div>
            
            {/* AI 对话浮动按钮 */}
            <div className="mt-10 flex justify-center border-t border-dashed border-slate-200 pt-8">
               <button className="flex items-center gap-2 px-5 py-2.5 bg-slate-900 text-white rounded-full font-medium hover:bg-slate-800 transition shadow-md hover:shadow-lg transform hover:-translate-y-0.5">
                 <Bot size={18} />
                 对此文件发起对话
               </button>
            </div>
          </div>
        </div>
      </div>

      {/* 右侧栏：AI Agent & 操作审批流 */}
      <div className="w-80 bg-white border-l border-slate-200 flex flex-col shadow-[-4px_0_15px_-3px_rgba(0,0,0,0.05)] z-20">
        
        {/* Tab 切换 */}
        <div className="flex border-b border-slate-200">
          <button 
            onClick={() => setActiveTab('chat')}
            className={`flex-1 py-3 text-sm font-medium flex items-center justify-center gap-2 transition-colors ${activeTab === 'chat' ? 'text-blue-600 border-b-2 border-blue-600 bg-blue-50/50' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-700'}`}
          >
            <MessageSquare size={16} />
            AI 助手
          </button>
          <button 
            onClick={() => setActiveTab('queue')}
            className={`flex-1 py-3 text-sm font-medium flex items-center justify-center gap-2 transition-colors ${activeTab === 'queue' ? 'text-amber-600 border-b-2 border-amber-600 bg-amber-50/50' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-700'}`}
          >
            <ListTodo size={16} />
            审批流
            {tasks.filter(t => t.status === 'pending').length > 0 && (
              <span className="bg-amber-100 text-amber-700 text-xs px-1.5 py-0.5 rounded-full font-bold">
                {tasks.filter(t => t.status === 'pending').length}
              </span>
            )}
          </button>
        </div>

        {/* Tab 内容区 */}
        <div className="flex-1 overflow-hidden relative">
          
          {/* Chat 面板 */}
          {activeTab === 'chat' && (
            <div className="absolute inset-0 flex flex-col bg-slate-50/50">
              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                <div className="text-center text-xs text-slate-400 my-2">2026-07-07 10:30 AM</div>
                
                {mockChat.map((msg, i) => (
                  <div key={i} className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${msg.role === 'user' ? 'bg-blue-100 text-blue-600' : 'bg-slate-800 text-white'}`}>
                      {msg.role === 'user' ? <User size={16} /> : <Bot size={16} />}
                    </div>
                    <div className={`p-3 rounded-lg text-sm max-w-[80%] whitespace-pre-wrap ${msg.role === 'user' ? 'bg-blue-600 text-white rounded-tr-none' : 'bg-white border border-slate-200 text-slate-700 rounded-tl-none shadow-sm'}`}>
                      {msg.content}
                    </div>
                  </div>
                ))}
              </div>
              <div className="p-3 bg-white border-t border-slate-200">
                <div className="relative">
                  <textarea 
                    className="w-full bg-slate-100 border-none rounded-lg pl-3 pr-10 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 resize-none" 
                    placeholder="如：帮我分析项目结构..."
                    rows={2}
                    value={chatMessage}
                    onChange={(e) => setChatMessage(e.target.value)}
                  ></textarea>
                  <button className="absolute right-2 bottom-2 p-1.5 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition">
                    <Send size={14} />
                  </button>
                </div>
                <div className="flex gap-2 mt-2">
                  <button className="text-[11px] bg-slate-100 hover:bg-slate-200 text-slate-600 px-2 py-1 rounded transition">分析目录结构</button>
                  <button className="text-[11px] bg-slate-100 hover:bg-slate-200 text-slate-600 px-2 py-1 rounded transition">生成项目摘要</button>
                </div>
              </div>
            </div>
          )}

          {/* 审批队列面板 */}
          {activeTab === 'queue' && (
            <div className="absolute inset-0 flex flex-col bg-slate-50">
              <div className="p-4 border-b border-slate-200 bg-white flex justify-between items-center">
                <div className="text-sm font-medium text-slate-800">待处理任务</div>
                <div className="space-x-2">
                  <button className="text-xs px-2 py-1 bg-green-50 text-green-700 hover:bg-green-100 rounded font-medium border border-green-200 transition">全部批准</button>
                  <button className="text-xs px-2 py-1 bg-slate-100 text-slate-600 hover:bg-slate-200 rounded font-medium transition">拒绝</button>
                </div>
              </div>
              
              <div className="flex-1 overflow-y-auto p-3 space-y-3">
                {tasks.map(task => (
                  <div key={task.id} className={`bg-white border rounded-lg p-3 shadow-sm transition-all ${
                    task.status === 'executed' ? 'border-green-200 bg-green-50/30' : 
                    task.status === 'rejected' ? 'border-slate-200 bg-slate-50 opacity-60' : 
                    task.warning ? 'border-red-200 border-l-4 border-l-red-500' : 'border-slate-200 hover:border-blue-300'
                  }`}>
                    
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">
                        {task.type === 'create_folder' && <span className="bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded text-xs">创建目录</span>}
                        {task.type === 'move_file' && <span className="bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded text-xs">移动文件</span>}
                        {task.type === 'delete_file' && <span className="bg-red-100 text-red-700 px-1.5 py-0.5 rounded text-xs">删除文件</span>}
                      </div>
                      
                      {task.status === 'pending' && (
                        <div className="flex gap-1">
                          <button onClick={() => handleApprove(task.id)} className="p-1 text-green-600 hover:bg-green-100 rounded" title="批准并执行">
                            <CheckCircle size={18} />
                          </button>
                          <button onClick={() => handleReject(task.id)} className="p-1 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded" title="拒绝">
                            <XCircle size={18} />
                          </button>
                        </div>
                      )}
                      {task.status === 'executed' && <span className="text-xs font-medium text-green-600 flex items-center gap-1"><CheckCircle size={14}/>已执行</span>}
                      {task.status === 'rejected' && <span className="text-xs font-medium text-slate-500">已拒绝</span>}
                    </div>
                    
                    <div className="text-xs text-slate-600 space-y-1 font-mono bg-slate-50 p-2 rounded">
                      {task.source && <div className="truncate opacity-70 line-through" title={task.source}>{task.source}</div>}
                      {task.target && <div className="truncate text-blue-700" title={task.target}>→ {task.target}</div>}
                      {task.path && <div className="truncate" title={task.path}>{task.path}</div>}
                    </div>

                    {task.warning && (
                      <div className="mt-2 text-xs text-red-600 flex items-center gap-1 bg-red-50 p-1.5 rounded font-medium">
                        <AlertTriangle size={12} />
                        {task.warning}
                      </div>
                    )}
                  </div>
                ))}
                
                {tasks.length === 0 && (
                  <div className="text-center py-10 text-slate-400 text-sm">
                    <CheckCircle size={32} className="mx-auto mb-2 opacity-50" />
                    队列已清空，无待办操作
                  </div>
                )}
              </div>
              
              <div className="p-3 bg-slate-100 border-t border-slate-200 text-xs text-slate-500 flex items-center justify-between">
                <span>保护模式: <strong className="text-green-600">Shadow 开启</strong></span>
                <span>事务安全: <strong className="text-green-600">保证</strong></span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// 辅助组件：文件树节点
function FileTreeNode({ node, depth }) {
  const isFolder = node.type === 'folder';
  const Icon = node.icon || Folder;
  
  return (
    <div>
      <div 
        className={`flex items-center gap-1.5 py-1.5 px-2 rounded-md cursor-pointer transition ${node.name === 'API设计.md' ? 'bg-blue-600 text-white' : 'hover:bg-slate-800 text-slate-300'}`}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        <span className="w-4 shrink-0 flex justify-center text-slate-500">
          {isFolder && (node.isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />)}
        </span>
        <Icon size={14} className={node.name === 'API设计.md' ? 'text-white' : (isFolder ? 'text-blue-400' : 'text-slate-400')} />
        <span className="truncate flex-1">{node.name}</span>
        {node.size && <span className={`text-[10px] ${node.name === 'API设计.md' ? 'text-blue-200' : 'text-slate-600'}`}>{node.size}</span>}
      </div>
      
      {isFolder && node.isOpen && node.children && (
        <div className="mt-0.5">
          {node.children.map((child, idx) => (
            <FileTreeNode key={idx} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}