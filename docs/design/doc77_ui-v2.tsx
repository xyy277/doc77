import React, { useState, useEffect } from 'react';
import { 
  Folder, FileText, FileCode, FileImage, FileDown, 
  ChevronRight, ChevronDown, Edit, ExternalLink, 
  MessageSquare, ListTodo, Search, Settings, 
  CheckCircle, XCircle, AlertTriangle, Sparkles,
  Bot, User, Send, RefreshCw, PanelLeftClose, PanelRightClose,
  PanelLeft, PanelRight, Wifi, WifiOff, Loader2, File, Plus,
  Info
} from 'lucide-react';

// --- Mock Data ---
const mockProjects = [
  { id: 1, name: '💼 客户A项目', path: '~/work/customer-a-docs' },
  { id: 2, name: '🚀 Doc77 源码', path: '~/dev/doc77' },
];

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
  { name: '.doc77ignore', type: 'file', icon: FileCode, size: '1 KB', isIgnored: true },
];

const mockTasks = [
  { id: 'task_001', type: 'create_folder', path: '技术文档/archive', status: 'pending' },
  { id: 'task_002', type: 'delete_file', path: '技术文档/废弃接口.md', status: 'pending' }, // delete 总是受 shadow 保护，安全
  { id: 'task_003', type: 'write_file', path: '资源文件/演示视频_超大.mp4', status: 'pending', warning: '超大文件(120MB)，覆盖操作无法自动回滚' } // 大文件写操作才发出高危警告
];

export default function Doc77App() {
  const [activeTab, setActiveTab] = useState('chat'); // 'chat' or 'queue'
  const [tasks, setTasks] = useState(mockTasks);
  const [chatMessage, setChatMessage] = useState('');
  const [chatHistory, setChatHistory] = useState([]);
  
  // 新增优化状态
  const [selectedFile, setSelectedFile] = useState(null); // null 表示空白页状态
  const [fileFilter, setFileFilter] = useState('');
  const [showLeftPanel, setShowLeftPanel] = useState(true);
  const [showRightPanel, setShowRightPanel] = useState(true);
  const [sseStatus, setSseStatus] = useState('connected'); // connected, disconnected, connecting
  const [isProjectMenuOpen, setIsProjectMenuOpen] = useState(false);
  const [isApproveAllConfirmOpen, setIsApproveAllConfirmOpen] = useState(false);

  // 模拟任务执行流转 (pending -> approved -> executing -> executed)
  const simulateTaskExecution = (taskId) => {
    setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: 'approved' } : t));
    
    setTimeout(() => {
      setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: 'executing' } : t));
    }, 600);

    setTimeout(() => {
      setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: 'executed' } : t));
    }, 2500); // 模拟执行耗时
  };

  const handleApprove = (id) => simulateTaskExecution(id);
  const handleReject = (id) => setTasks(prev => prev.map(t => t.id === id ? { ...t, status: 'rejected' } : t));
  
  const handleApproveAll = () => {
    setIsApproveAllConfirmOpen(false);
    tasks.filter(t => t.status === 'pending').forEach(t => simulateTaskExecution(t.id));
  };

  const pendingCount = tasks.filter(t => t.status === 'pending').length;

  const handleSendMessage = () => {
    if (!chatMessage.trim()) return;
    setChatHistory([...chatHistory, { role: 'user', content: chatMessage }]);
    setChatMessage('');
    // 模拟 AI 思考和回复
    setTimeout(() => {
      setChatHistory(prev => [...prev, { role: 'ai', content: '我正在分析您的请求，请稍候...' }]);
    }, 500);
  };

  return (
    <div className="flex h-screen w-full bg-slate-50 text-slate-800 font-sans overflow-hidden">
      
      {/* === 左侧栏：项目与文件树 === */}
      {showLeftPanel && (
        <div className="w-64 shrink-0 bg-slate-900 text-slate-300 flex flex-col z-20 transition-all duration-300">
          <div className="h-14 px-4 border-b border-slate-800 flex items-center justify-between shrink-0">
            <div className="flex items-center gap-2 text-white font-bold text-lg">
              <span className="bg-blue-600 text-white p-1 rounded shadow-sm"><Folder size={18} /></span>
              Doc77
            </div>
            <button className="text-slate-400 hover:text-white transition" aria-label="Settings"><Settings size={18} /></button>
          </div>
          
          {/* 项目切换器 (Dropdown) */}
          <div className="p-3 relative">
            <button 
              onClick={() => setIsProjectMenuOpen(!isProjectMenuOpen)}
              className={`w-full text-left rounded px-3 py-2 text-sm flex items-center justify-between text-slate-200 cursor-pointer border transition-colors ${isProjectMenuOpen ? 'bg-slate-700 border-slate-600' : 'bg-slate-800 border-slate-700 hover:border-slate-600'}`}
              aria-expanded={isProjectMenuOpen}
              aria-haspopup="listbox"
            >
              <span className="font-medium truncate">💼 客户A项目</span>
              <ChevronDown size={14} className={`transform transition-transform ${isProjectMenuOpen ? 'rotate-180' : ''}`} />
            </button>
            
            {/* 项目下拉菜单 */}
            {isProjectMenuOpen && (
              <div className="absolute top-14 left-3 right-3 bg-slate-800 border border-slate-700 rounded-lg shadow-xl py-1 z-30" role="listbox">
                {mockProjects.map(p => (
                  <button key={p.id} onClick={() => setIsProjectMenuOpen(false)} className="w-full text-left px-3 py-2 text-sm text-slate-200 hover:bg-slate-700 flex flex-col" role="option" aria-selected={p.id === 1}>
                    <span className="font-medium">{p.name}</span>
                    <span className="text-xs text-slate-500 truncate">{p.path}</span>
                  </button>
                ))}
                <div className="h-px bg-slate-700 my-1"></div>
                <button className="w-full text-left px-3 py-2 text-sm text-blue-400 hover:bg-slate-700 flex items-center gap-1.5" onClick={() => setIsProjectMenuOpen(false)}>
                  <Plus size={14} /> 注册新项目
                </button>
              </div>
            )}
          </div>

          <div className="flex-1 flex flex-col min-h-0">
            <div className="px-4 pb-2 text-xs font-semibold text-slate-500 uppercase tracking-wider flex justify-between items-center shrink-0">
              目录树
              <button className="hover:text-slate-300" title="刷新缓存" aria-label="Refresh Tree"><RefreshCw size={12} /></button>
            </div>
            
            {/* 搜索框 */}
            <div className="px-3 mb-2 shrink-0">
              <div className="relative">
                <Search size={14} className="absolute left-2.5 top-2 text-slate-500" />
                <input 
                  type="text" 
                  placeholder="过滤文件..." 
                  className="w-full bg-slate-950 border border-slate-800 rounded pl-8 pr-2 py-1.5 text-xs focus:ring-1 focus:ring-blue-500 focus:border-blue-500 text-slate-200"
                  value={fileFilter}
                  onChange={(e) => setFileFilter(e.target.value)}
                  aria-label="Filter files"
                />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-2 space-y-0.5 text-sm" role="tree" aria-label="Project Files">
              {mockFileTree.map((item, idx) => (
                <FileTreeNode 
                  key={idx} 
                  node={item} 
                  depth={0} 
                  filter={fileFilter} 
                  selected={selectedFile === item.name} 
                  onSelect={(name) => setSelectedFile(name)} 
                />
              ))}
            </div>
          </div>
          
          {/* 状态栏：SSE 状态与版本号 */}
          <div className="p-3 border-t border-slate-800 flex flex-col gap-2 shrink-0 bg-slate-900/50">
            <div className="flex items-center justify-between">
              {sseStatus === 'connected' ? (
                <div className="flex items-center gap-1.5 text-xs text-emerald-500 font-medium" title="已连接到操作队列总线">
                  <Wifi size={14} /> 实时对账中
                </div>
              ) : sseStatus === 'connecting' ? (
                <div className="flex items-center gap-1.5 text-xs text-amber-500 font-medium">
                  <Loader2 size={14} className="animate-spin" /> 重连中...
                </div>
              ) : (
                <div className="flex items-center gap-1.5 text-xs text-red-400 font-medium cursor-pointer hover:text-red-300" onClick={() => { setSseStatus('connecting'); setTimeout(() => setSseStatus('connected'), 1500) }}>
                  <WifiOff size={14} /> SSE 断连 (点击重连)
                </div>
              )}
              <span className="text-[10px] text-slate-600">v2.5.0-beta</span>
            </div>
          </div>
        </div>
      )}

      {/* 拖拽/折叠把手 (Left) */}
      <div 
        className="w-1.5 bg-slate-200 hover:bg-blue-400 cursor-col-resize z-30 transition-colors hidden md:block border-x border-slate-300 flex-shrink-0"
        title="拖拽调整宽度 (模拟)"
      ></div>

      {/* === 中间栏：预览引擎工作区 === */}
      <div className="flex-1 flex flex-col bg-white min-w-0 relative">
        {/* 顶部工具栏 */}
        <div className="h-14 border-b border-slate-200 flex items-center justify-between px-4 bg-white shadow-sm z-10 shrink-0">
          <div className="flex items-center gap-2">
            {!showLeftPanel && (
              <button onClick={() => setShowLeftPanel(true)} className="p-1.5 text-slate-500 hover:bg-slate-100 rounded mr-1" aria-label="Show Sidebar">
                <PanelLeft size={16} />
              </button>
            )}
            
            {selectedFile ? (
              <div className="flex items-center gap-2 text-sm text-slate-500 whitespace-nowrap overflow-hidden text-ellipsis">
                <span className="hover:text-slate-800 cursor-pointer hidden sm:inline">客户A项目</span>
                <ChevronRight size={14} className="hidden sm:inline" />
                <span className="hover:text-slate-800 cursor-pointer hidden sm:inline">技术文档</span>
                <ChevronRight size={14} className="hidden sm:inline" />
                <span className="font-medium text-slate-800 flex items-center gap-1 shrink-0">
                  <FileText size={14} className="text-blue-500" />
                  {selectedFile}
                </span>
              </div>
            ) : (
              <span className="text-sm font-medium text-slate-400">未选择文件</span>
            )}
          </div>
          
          <div className="flex items-center gap-1.5 sm:gap-3">
            {selectedFile && (
              <>
                <button className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-purple-600 bg-purple-50 hover:bg-purple-100 rounded-md transition border border-purple-100">
                  <Sparkles size={14} />
                  <span className="hidden sm:inline">AI 总结</span>
                </button>
                <div className="h-4 w-px bg-slate-300 hidden sm:block"></div>
                <button className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-md transition" title="在VS Code中打开">
                  <Edit size={14} />
                  编辑器打开
                </button>
                <button className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-md transition" title="在系统文件管理器中显示">
                  <ExternalLink size={14} />
                  <span className="hidden sm:inline">文件夹中显示</span>
                </button>
              </>
            )}
            {!showRightPanel && (
              <button onClick={() => setShowRightPanel(true)} className="p-1.5 ml-2 text-slate-500 hover:bg-slate-100 rounded" aria-label="Show Agent">
                <PanelRight size={16} />
              </button>
            )}
          </div>
        </div>

        {/* 动态内容区 (Empty vs Document) */}
        <div className="flex-1 overflow-y-auto bg-slate-50 relative">
          
          {!selectedFile ? (
            /* Empty State */
            <div className="h-full flex flex-col items-center justify-center text-slate-400 p-8">
               <File size={64} strokeWidth={1} className="mb-4 text-slate-300" />
               <h2 className="text-xl font-medium text-slate-600 mb-2">Doc77 预览引擎</h2>
               <p className="text-sm text-center max-w-sm mb-6">从左侧目录树选择文件以进行只读预览，或通过右侧 AI 助手对整个项目进行管理与重构。</p>
               <button 
                  onClick={() => { setShowRightPanel(true); setActiveTab('chat'); }}
                  className="px-4 py-2 bg-white border border-slate-200 rounded-lg shadow-sm hover:border-blue-400 hover:text-blue-600 transition flex items-center gap-2 text-sm font-medium"
                >
                 <Sparkles size={16}/> 唤起 AI 助手
               </button>
            </div>
          ) : (
            /* Document Preview State */
            <div className="p-4 sm:p-10 relative">
              <div className="max-w-4xl mx-auto bg-white p-8 sm:p-12 rounded-xl shadow-sm border border-slate-200">
                <h1 className="text-2xl sm:text-3xl font-bold mb-6 text-slate-900 border-b pb-4">{selectedFile}</h1>
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
                        <th className="border border-slate-300 px-4 py-2 text-left">状态码</th>
                        <th className="border border-slate-300 px-4 py-2 text-left">说明</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td className="border border-slate-300 px-4 py-2 text-green-600 font-mono">200</td>
                        <td className="border border-slate-300 px-4 py-2">请求成功并返回预期数据</td>
                      </tr>
                      <tr>
                        <td className="border border-slate-300 px-4 py-2 text-red-600 font-mono">400</td>
                        <td className="border border-slate-300 px-4 py-2">参数校验失败，需检查入参</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                
                {/* 底部 AI 发起按钮 */}
                <div className="mt-10 flex justify-center border-t border-dashed border-slate-200 pt-8">
                  <button 
                    onClick={() => { setShowRightPanel(true); setActiveTab('chat'); }}
                    className="flex items-center gap-2 px-5 py-2.5 bg-slate-900 text-white rounded-full font-medium hover:bg-slate-800 transition shadow-md hover:shadow-lg transform hover:-translate-y-0.5 focus:ring-2 focus:ring-offset-2 focus:ring-slate-900"
                  >
                    <Bot size={18} />
                    对此文件发起对话
                  </button>
                </div>
              </div>

              {/* 浮动的 AI 洞察面板 */}
              <div className="fixed bottom-6 right-6 md:right-88 max-w-sm bg-white rounded-lg shadow-xl border border-blue-100 overflow-hidden z-20 animate-fade-in-up">
                <div className="bg-blue-50 px-3 py-2 flex items-center justify-between border-b border-blue-100">
                  <div className="flex items-center gap-1.5 text-blue-800 font-semibold text-sm">
                    <Sparkles size={14} className="text-blue-500" /> AI 洞察 (针对当前文档)
                  </div>
                  <button className="text-blue-400 hover:text-blue-600" aria-label="Dismiss"><XCircle size={14} /></button>
                </div>
                <div className="p-3 text-sm text-slate-700 leading-relaxed">
                  此文档与上周更新的《架构图.mermaid》部分字段映射存在轻微脱节。建议您使用右侧栏让 AI 自动检测冲突。
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 拖拽/折叠把手 (Right) */}
      <div 
        className="w-1.5 bg-slate-200 hover:bg-amber-400 cursor-col-resize z-30 transition-colors hidden md:block border-x border-slate-300 flex-shrink-0"
        title="拖拽调整宽度 (模拟)"
      ></div>

      {/* === 右侧栏：AI Agent & 操作审批流 === */}
      {showRightPanel && (
        <div className="w-80 shrink-0 bg-white border-l border-slate-200 flex flex-col shadow-[-4px_0_15px_-3px_rgba(0,0,0,0.05)] z-20 transition-all duration-300">
          
          {/* 顶部操作区 (含关闭) */}
          <div className="flex border-b border-slate-200 bg-slate-50 items-center pr-2" role="tablist">
            <button 
              onClick={() => setActiveTab('chat')}
              role="tab"
              aria-selected={activeTab === 'chat'}
              className={`flex-1 py-3 text-sm font-medium flex items-center justify-center gap-2 transition-colors ${activeTab === 'chat' ? 'text-blue-600 border-b-2 border-blue-600 bg-white' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'}`}
            >
              <MessageSquare size={16} />
              AI 助手
            </button>
            <button 
              onClick={() => setActiveTab('queue')}
              role="tab"
              aria-selected={activeTab === 'queue'}
              className={`flex-1 py-3 text-sm font-medium flex items-center justify-center gap-2 transition-colors ${activeTab === 'queue' ? 'text-amber-600 border-b-2 border-amber-600 bg-white' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'}`}
            >
              <ListTodo size={16} />
              审批流
              {pendingCount > 0 && (
                <span className="bg-amber-100 text-amber-700 text-[10px] px-1.5 py-0.5 rounded-full font-bold ml-1">
                  {pendingCount}
                </span>
              )}
            </button>
            <button onClick={() => setShowRightPanel(false)} className="p-1.5 text-slate-400 hover:bg-slate-200 rounded ml-1" title="收起面板" aria-label="Close Right Panel">
              <PanelRightClose size={14} />
            </button>
          </div>

          {/* Tab 内容区 */}
          <div className="flex-1 overflow-hidden relative">
            
            {/* --- Chat 面板 --- */}
            {activeTab === 'chat' && (
              <div className="absolute inset-0 flex flex-col bg-slate-50/50" role="tabpanel">
                
                {/* 上下文 Banner */}
                {selectedFile && (
                  <div className="bg-blue-50/80 border-b border-blue-100 px-3 py-1.5 flex items-center gap-2 text-xs text-blue-800 shadow-sm shrink-0">
                    <FileText size={12} className="text-blue-500" /> 
                    <span className="truncate">当前上下文: <strong>技术文档/{selectedFile}</strong></span>
                  </div>
                )}

                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                  {/* 空白状态下的 Welcome Card (取代底部固定的快捷按钮) */}
                  {chatHistory.length === 0 && (
                    <div className="bg-white border border-slate-200 rounded-lg p-4 shadow-sm">
                      <div className="flex items-center gap-2 font-bold text-slate-800 mb-2">
                        <Bot size={18} className="text-blue-600" /> 您好！我是 Doc77 助手
                      </div>
                      <p className="text-xs text-slate-600 mb-4 leading-relaxed">
                        我可以帮您阅读、总结当前项目，或直接生成重构建议与操作指令。
                      </p>
                      <div className="space-y-2">
                        <button className="w-full text-left text-xs bg-slate-50 hover:bg-blue-50 hover:text-blue-700 border border-slate-100 hover:border-blue-200 p-2 rounded transition" onClick={() => setChatMessage("帮我分析整个项目的目录结构并找出孤儿文件。")}>
                          🔍 分析目录结构
                        </button>
                        <button className="w-full text-left text-xs bg-slate-50 hover:bg-blue-50 hover:text-blue-700 border border-slate-100 hover:border-blue-200 p-2 rounded transition" onClick={() => setChatMessage("请为我生成当前项目的完整摘要报告。")}>
                          📝 生成项目摘要
                        </button>
                      </div>
                    </div>
                  )}

                  {chatHistory.map((msg, i) => (
                    <div key={i} className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
                      <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${msg.role === 'user' ? 'bg-blue-100 text-blue-600' : 'bg-slate-800 text-white shadow-sm'}`}>
                        {msg.role === 'user' ? <User size={14} /> : <Bot size={14} />}
                      </div>
                      <div className={`p-3 rounded-lg text-sm max-w-[85%] whitespace-pre-wrap leading-relaxed ${msg.role === 'user' ? 'bg-blue-600 text-white rounded-tr-none shadow-sm' : 'bg-white border border-slate-200 text-slate-700 rounded-tl-none shadow-sm'}`}>
                        {msg.content}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="p-3 bg-white border-t border-slate-200 shrink-0">
                  <div className="relative">
                    <textarea 
                      className="w-full bg-slate-100 border-none rounded-lg pl-3 pr-10 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 resize-none" 
                      placeholder="发送自然语言指令..."
                      rows={2}
                      value={chatMessage}
                      onChange={(e) => setChatMessage(e.target.value)}
                      onKeyDown={(e) => { if(e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendMessage(); } }}
                    ></textarea>
                    <button 
                      onClick={handleSendMessage}
                      className="absolute right-2 bottom-2 p-1.5 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition disabled:opacity-50"
                      disabled={!chatMessage.trim()}
                    >
                      <Send size={14} />
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* --- 审批队列面板 --- */}
            {activeTab === 'queue' && (
              <div className="absolute inset-0 flex flex-col bg-slate-50" role="tabpanel">
                <div className="p-3 border-b border-slate-200 bg-white flex justify-between items-center shrink-0 shadow-sm z-10">
                  <div className="text-sm font-bold text-slate-800">待处理任务 ({pendingCount})</div>
                  {pendingCount > 0 && (
                    <div className="space-x-1.5 relative">
                      <button 
                        onClick={() => setIsApproveAllConfirmOpen(true)}
                        className="text-[11px] px-2 py-1.5 bg-green-600 text-white hover:bg-green-700 rounded font-medium shadow-sm transition"
                        aria-label="Approve All Pending Tasks"
                      >
                        批准全部
                      </button>
                      <button onClick={() => tasks.filter(t => t.status === 'pending').forEach(t => handleReject(t.id))} className="text-[11px] px-2 py-1.5 bg-slate-100 text-slate-600 hover:bg-slate-200 rounded font-medium transition border border-slate-200">
                        拒绝全部
                      </button>

                      {/* 二次确认 Popover */}
                      {isApproveAllConfirmOpen && (
                        <div className="absolute top-10 right-0 w-48 bg-white border border-slate-200 shadow-xl rounded-lg p-3 z-50">
                          <div className="text-xs font-semibold text-slate-800 mb-2">确定批准全部 {pendingCount} 项操作？</div>
                          <div className="flex gap-2">
                            <button onClick={handleApproveAll} className="flex-1 bg-green-600 text-white text-xs py-1.5 rounded hover:bg-green-700 transition">确认执行</button>
                            <button onClick={() => setIsApproveAllConfirmOpen(false)} className="flex-1 bg-slate-100 text-slate-600 text-xs py-1.5 rounded hover:bg-slate-200 transition">取消</button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
                
                <div className="flex-1 overflow-y-auto p-3 space-y-3 relative">
                  {tasks.map(task => (
                    <div key={task.id} className={`bg-white border rounded-lg p-3 shadow-sm transition-all duration-500 relative overflow-hidden ${
                      task.status === 'executed' ? 'border-emerald-200 bg-emerald-50/50' : 
                      task.status === 'rejected' ? 'border-slate-200 bg-slate-50 opacity-60' : 
                      task.status === 'executing' ? 'border-blue-300 ring-2 ring-blue-100' :
                      task.warning ? 'border-red-200 border-l-4 border-l-red-500 hover:shadow-md' : 'border-slate-200 hover:border-blue-300 hover:shadow-md'
                    }`}>
                      
                      {/* 执行中 进度条动画 */}
                      {task.status === 'executing' && (
                        <div className="absolute top-0 left-0 h-1 bg-blue-500 animate-[pulse_1s_ease-in-out_infinite] w-full"></div>
                      )}

                      <div className="flex items-start justify-between mb-2">
                        <div className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">
                          {task.type === 'create_folder' && <span className="bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded text-[10px] font-bold tracking-wider">创建目录</span>}
                          {task.type === 'write_file' && <span className="bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded text-[10px] font-bold tracking-wider">写入覆盖</span>}
                          {task.type === 'delete_file' && <span className="bg-red-100 text-red-700 px-1.5 py-0.5 rounded text-[10px] font-bold tracking-wider">安全删除</span>}
                        </div>
                        
                        {/* 状态操作区 */}
                        {task.status === 'pending' && (
                          <div className="flex gap-1">
                            <button onClick={() => handleApprove(task.id)} className="p-1 text-green-600 hover:bg-green-100 rounded transition-colors" aria-label="Approve Task">
                              <CheckCircle size={18} />
                            </button>
                            <button onClick={() => handleReject(task.id)} className="p-1 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded transition-colors" aria-label="Reject Task">
                              <XCircle size={18} />
                            </button>
                          </div>
                        )}
                        {task.status === 'approved' && <span className="text-xs font-bold text-amber-500 flex items-center gap-1"><Loader2 size={12} className="animate-spin" /> 排队中</span>}
                        {task.status === 'executing' && <span className="text-xs font-bold text-blue-600 flex items-center gap-1"><Loader2 size={12} className="animate-spin" /> 执行中</span>}
                        {task.status === 'executed' && <span className="text-xs font-bold text-emerald-600 flex items-center gap-1"><CheckCircle size={14}/>已执行</span>}
                        {task.status === 'rejected' && <span className="text-xs font-bold text-slate-400">已拒绝</span>}
                      </div>
                      
                      {/* 操作详情路径 */}
                      <div className="text-[11px] text-slate-600 space-y-1 font-mono bg-slate-50 p-2 rounded border border-slate-100">
                        {task.source && <div className="truncate opacity-70 line-through" title={task.source}>{task.source}</div>}
                        {task.target && <div className="truncate text-blue-700" title={task.target}>→ {task.target}</div>}
                        {task.path && <div className="truncate" title={task.path}>{task.path}</div>}
                      </div>

                      {/* 高危警告 (针对大文件覆写) */}
                      {task.warning && task.status === 'pending' && (
                        <div className="mt-2 text-[11px] text-red-700 flex items-start gap-1.5 bg-red-50/80 p-2 rounded font-medium border border-red-100 leading-tight">
                          <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                          <span>{task.warning}</span>
                        </div>
                      )}
                      {/* 普通删除的提示 (Shadow保护) */}
                      {task.type === 'delete_file' && task.status === 'pending' && (
                         <div className="mt-2 text-[10px] text-emerald-600 flex items-center gap-1">
                           <Info size={12}/> 操作受 Shadow 隔离保护，支持回滚。
                         </div>
                      )}
                    </div>
                  ))}
                  
                  {tasks.length === 0 && (
                    <div className="text-center py-10 text-slate-400 text-sm flex flex-col items-center">
                      <CheckCircle size={32} className="mb-3 opacity-50 text-slate-300" />
                      队列已清空，无待办操作
                    </div>
                  )}
                </div>
                
                <div className="p-3 bg-slate-900 border-t border-slate-800 text-[11px] text-slate-300 flex items-center justify-between shrink-0 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.1)]">
                  <span className="flex items-center gap-1">
                     <span className="relative flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                    </span>
                    事务锁: <strong className="text-white">监控中</strong>
                  </span>
                  <span>Shadow 备份: <strong className="text-emerald-400">已开启</strong></span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// 辅助组件：文件树节点 (支持过滤与无障碍属性)
function FileTreeNode({ node, depth, filter, selected, onSelect }) {
  const isFolder = node.type === 'folder';
  const Icon = node.icon || Folder;
  const isIgnored = node.isIgnored;

  // 简单的过滤逻辑 (如果是文件夹，且其子元素都没命中，则不渲染；为了演示简化，只按名称匹配)
  if (filter && !node.name.toLowerCase().includes(filter.toLowerCase()) && !isFolder) {
    return null;
  }
  
  return (
    <div role="treeitem" aria-expanded={isFolder ? node.isOpen : undefined} aria-selected={selected}>
      <div 
        onClick={() => { if (!isFolder) onSelect(node.name) }}
        className={`flex items-center gap-1.5 py-1.5 px-2 rounded-md cursor-pointer transition ${
          selected ? 'bg-blue-600 text-white shadow-sm' : 
          'hover:bg-slate-800 text-slate-300'
        } ${isIgnored ? 'opacity-40 hover:opacity-80' : ''}`}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
      >
        <span className="w-4 shrink-0 flex justify-center text-slate-500">
          {isFolder && (node.isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />)}
        </span>
        <Icon size={14} className={selected ? 'text-white' : (isFolder ? 'text-blue-400' : isIgnored ? 'text-slate-500' : 'text-slate-400')} />
        <span className={`truncate flex-1 ${isIgnored ? 'line-through decoration-slate-600 decoration-1' : ''}`}>{node.name}</span>
        {node.size && <span className={`text-[10px] ${selected ? 'text-blue-200' : 'text-slate-500'}`}>{node.size}</span>}
      </div>
      
      {isFolder && node.isOpen && node.children && (
        <div className="mt-0.5" role="group">
          {node.children.map((child, idx) => (
            <FileTreeNode key={idx} node={child} depth={depth + 1} filter={filter} selected={selected} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  );
}